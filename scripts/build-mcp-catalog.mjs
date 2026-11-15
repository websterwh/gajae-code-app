#!/usr/bin/env node
/**
 * Build the bundled MCP catalog from maintained indexes.
 *
 * This runs by hand, with network, and its output is committed. The app never
 * calls any of these sources at request time.
 *
 *   node scripts/build-mcp-catalog.mjs
 *
 * Sources:
 *  - vaibhav4046/mcp-marketplace servers.json + servers.seed.json (MIT)
 *  - the official MCP registry (packages only, runnable commands)
 *  - data/catalog.curated.json, merged last so regeneration cannot drop it
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKETPLACE_URL = 'https://raw.githubusercontent.com/vaibhav4046/mcp-marketplace/main/data/servers.json';
const SEED_URL = 'https://raw.githubusercontent.com/vaibhav4046/mcp-marketplace/main/data/servers.seed.json';
const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
const REGISTRY_PAGES = 8;
const RUNNABLE = /^(npx|uvx|uv|docker|pipx)\b/u;

const githubToken = process.env.GITHUB_TOKEN
  || (() => {
    try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return ''; }
  })();

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function slugName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
}

function argsString(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

/** Pull a concrete command out of the marketplace install block. */
function marketplaceCommand(record) {
  const install = isRecord(record.install) ? record.install : {};
  const desktop = isRecord(install.claudeDesktop) ? install.claudeDesktop : null;
  if (desktop && typeof desktop.command === 'string' && RUNNABLE.test(desktop.command.trim())) {
    return { command: desktop.command.trim(), args: argsString(desktop.args), env: isRecord(desktop.env) ? desktop.env : {} };
  }
  const cli = typeof install.cli === 'string' ? install.cli.trim() : '';
  if (cli && RUNNABLE.test(cli)) {
    // Only simple space-separated commands are accepted; a pipeline is not one.
    if (/[|;&>`$]/u.test(cli)) return null;
    const [command, ...args] = cli.split(/\s+/u);
    return { command, args, env: {} };
  }
  return null;
}

function packageFrom(command, args, fallbackName) {
  let name = '';
  const fromIndex = args.indexOf('--from');
  if (fromIndex >= 0 && args[fromIndex + 1]) name = args[fromIndex + 1];
  if (!name) name = args.find((arg) => !arg.startsWith('-')) ?? fallbackName;
  if (!name) return undefined;
  const manager = command === 'npx' ? 'npm' : command === 'uvx' || command === 'uv' || command === 'pipx' ? 'pypi' : 'other';
  return { manager, name };
}

function repositoryUrl(record) {
  const value = typeof record.repo === 'string' ? record.repo : typeof record.repository === 'string' ? record.repository : '';
  return value || undefined;
}

function envFrom(value) {
  if (!isRecord(value)) return undefined;
  const env = Object.entries(value)
    .filter(([key, entry]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && (typeof entry === 'string' || typeof entry === 'number'))
    .map(([name]) => ({ name, required: false }));
  return env.length ? env : undefined;
}

function fromMarketplace(record) {
  const command = marketplaceCommand(record);
  if (!command || !isRecord(record)) return null;
  const name = slugName(record.slug || record.name);
  if (!name) return null;
  const transport = Array.isArray(record.transports) && record.transports.includes('stdio') ? 'stdio' : 'stdio';
  const repository = repositoryUrl(record);
  const pkg = packageFrom(command.command, command.args, name);
  const stars = typeof record.stars === 'number' && Number.isFinite(record.stars) ? record.stars : undefined;
  return {
    name,
    title: typeof record.name === 'string' ? record.name : undefined,
    description: String(record.tagline || record.description || '').trim(),
    transport,
    command: command.command,
    args: command.args,
    ...(pkg ? { package: pkg } : {}),
    ...(envFrom(command.env) ? { env: envFrom(command.env) } : {}),
    ...(stars ? { stars } : {}),
    ...(typeof record.homepage === 'string' ? { homepage: record.homepage } : {}),
    ...(repository ? { repository: { url: repository, source: 'marketplace' } } : {}),
  };
}

function fromRegistry(record) {
  if (!isRecord(record)) return null;
  const server = isRecord(record.server) ? record.server : record;
  const name = slugName(server.name);
  if (!name) return null;
  const packages = Array.isArray(server.packages) ? server.packages.filter(isRecord) : [];
  const first = packages[0];
  if (first && typeof first.identifier === 'string' && first.identifier) {
    const registryType = String(first.registryType ?? '').toLowerCase();
    const command = registryType === 'npm' ? 'npx' : registryType === 'pypi' ? 'uvx' : 'docker';
    const args = command === 'npx' ? ['-y', first.identifier]
      : command === 'docker' ? ['run', '-i', '--rm', first.identifier] : [first.identifier];
    const env = (Array.isArray(first.environmentVariables) ? first.environmentVariables : [])
      .filter((entry) => isRecord(entry) && typeof entry.name === 'string')
      .map((entry) => ({
        name: entry.name,
        required: entry.isRequired === true,
        secret: entry.isSecret === true,
      }));
    const repository = isRecord(server.repository) && typeof server.repository.url === 'string' ? server.repository.url : undefined;
    return {
      name,
      title: typeof server.title === 'string' ? server.title : undefined,
      description: String(server.description ?? '').trim(),
      transport: 'stdio',
      command,
      args,
      package: { manager: registryType === 'npm' ? 'npm' : registryType === 'pypi' ? 'pypi' : 'other', name: first.identifier, ...(typeof first.version === 'string' ? { version: first.version } : {}) },
      ...(env.length ? { env } : {}),
      ...(repository ? { repository: { url: repository, source: 'registry' } } : {}),
    };
  }
  return null;
}

const starCache = new Map();
async function starsFor(url) {
  if (!url) return undefined;
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/u.exec(url);
  if (!match) return undefined;
  const key = `${match[1]}/${match[2].replace(/\.git$/u, '')}`;
  if (starCache.has(key)) return starCache.get(key);
  try {
    const response = await fetch(`https://api.github.com/repos/${key}`, {
      headers: {
        accept: 'application/vnd.github+json',
        ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) { starCache.set(key, undefined); return undefined; }
    const body = await response.json();
    const value = typeof body.stargazers_count === 'number' ? body.stargazers_count : undefined;
    starCache.set(key, value);
    return value;
  } catch {
    starCache.set(key, undefined);
    return undefined;
  }
}

function dedupe(entries) {
  const byPackage = new Map();
  const byName = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    const packageName = entry.package?.name?.toLowerCase();
    const existing = (packageName ? byPackage.get(packageName) : undefined) ?? byName.get(entry.name);
    if (existing) {
      if ((entry.stars ?? 0) > (existing.stars ?? 0)) Object.assign(existing, entry);
      continue;
    }
    if (packageName) byPackage.set(packageName, entry);
    byName.set(entry.name, entry);
  }
  return [...new Set([...byPackage.values(), ...byName.values()])];
}

async function main() {
  console.log('fetching marketplace…');
  const marketplace = await json(MARKETPLACE_URL);
  console.log('fetching seed…');
  const seed = await json(SEED_URL).catch(() => ({ servers: [] }));
  const registry = [];
  let cursor;
  for (let page = 0; page < REGISTRY_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: '100', version: 'latest', ...(cursor ? { cursor } : {}) });
    const body = await json(`${REGISTRY_URL}?${params}`);
    const records = Array.isArray(body.servers) ? body.servers : [];
    registry.push(...records.map(fromRegistry).filter(Boolean));
    cursor = body.metadata?.nextCursor;
    console.log(`registry page ${page + 1}: ${records.length} records`);
    if (!cursor) break;
  }

  const raw = [...(marketplace.servers ?? []), ...(seed.servers ?? [])];
  const generated = dedupe([
    ...raw.map(fromMarketplace).filter(Boolean),
    ...registry,
  ]);

  let done = 0;
  for (const entry of generated) {
    if (typeof entry.stars === 'number') continue;
    const stars = await starsFor(entry.repository?.url);
    if (typeof stars === 'number') entry.stars = stars;
    done += 1;
    if (done % 25 === 0) console.log(`stars ${done}/${generated.length}`);
  }

  const curated = JSON.parse(await readFile(path.join(root, 'data', 'catalog.curated.json'), 'utf8'));
  const curatedNames = new Set(curated.map((entry) => entry.name));
  const curatedPackages = new Set(curated.map((entry) => entry.package?.name?.toLowerCase()).filter(Boolean));
  const surviving = generated.filter((entry) => {
    if (curatedNames.has(entry.name)) return false;
    const pkg = entry.package?.name?.toLowerCase();
    if (pkg && curatedPackages.has(pkg)) return false;
    return true;
  });
  const merged = [...surviving, ...curated]
    .filter((entry) => entry.transport !== 'stdio' || entry.command)
    .sort((a, b) => a.name.localeCompare(b.name));

  const output = `${JSON.stringify(merged, null, 2)}\n`;
  await writeFile(path.join(root, 'server', 'modules', 'mcp', 'catalog.data.json'), output, 'utf8');
  await mkdir(path.join(root, 'deploy', 'mcp'), { recursive: true });
  await writeFile(path.join(root, 'deploy', 'mcp', 'catalog.json'), output, 'utf8');
  await writeFile(path.join(root, 'deploy', 'mcp', 'README.md'), `# Generated MCP catalog

Generated by \`scripts/build-mcp-catalog.mjs\`. Do not edit by hand.

- Source: ${MARKETPLACE_URL} (MIT, generated ${marketplace.generatedAt ?? 'unknown'}, totalCount ${marketplace.totalCount ?? 'unknown'})
- Cross-check: ${SEED_URL}
- Bulk supplement: ${REGISTRY_URL} (packages with runnable commands)
- Curated entries merged last: \`data/catalog.curated.json\`
- Output entries: ${merged.length}

The bundled copy lives at \`server/modules/mcp/catalog.data.json\`; this file is
the same content, served as the curated overlay so the app can grow without a
new image. Stars were re-fetched from the GitHub API at generation time; the
runtime never calls it to render the list.
`, 'utf8');
  console.log(`wrote ${merged.length} entries`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
