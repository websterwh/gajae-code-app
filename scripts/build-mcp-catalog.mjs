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
 *  - vaibhav4046/mcp-marketplace servers.json + servers.seed.json (MIT), only
 *    records with a concrete runnable command or a real remote URL
 *  - Docker Hub's mcp namespace, cross-checked against docker/mcp-registry so
 *    only images Docker actually publishes are bundled
 *  - data/catalog.curated.json, merged last so regeneration cannot drop it
 *
 * The official MCP registry is deliberately not a source. It is the runtime
 * fallback for the long tail; copying it into the image is how namespaced
 * packages such as `ai.foo` once buried every recognizable server.
 *
 * Test hooks (no network): CATALOG_MARKETPLACE_FILE, CATALOG_SEED_FILE,
 * CATALOG_SKIP_DOCKER, CATALOG_MIN_ENTRIES, CATALOG_OUTPUT_DIR.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKETPLACE_URL = 'https://raw.githubusercontent.com/vaibhav4046/mcp-marketplace/main/data/servers.json';
const SEED_URL = 'https://raw.githubusercontent.com/vaibhav4046/mcp-marketplace/main/data/servers.seed.json';
const DOCKER_HUB_URL = 'https://hub.docker.com/v2/repositories/mcp/';
const DOCKER_TREE_URL = 'https://api.github.com/repos/docker/mcp-registry/git/trees/main?recursive=1';
const DOCKER_LIMIT = 60;
const RUNNABLE = /^(npx|uvx|uv|docker|pipx)\b/u;
/** Bundled names have no slash and no dotted vendor prefix. */
const BUNDLED_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const SUBTREE_URL = /\/tree\/|\/blob\//u;
const MIN_ENTRIES = Number.parseInt(process.env.CATALOG_MIN_ENTRIES ?? '60', 10);

async function remoteAnswers(url) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gajae-catalog-check', version: '1' } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    return (await response.text()).includes('"result"');
  } catch {
    return false;
  }
}

const githubToken = process.env.GITHUB_TOKEN
  || (() => {
    try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return ''; }
  })();

async function json(url) {
  const github = url.startsWith('https://api.github.com/') || url.startsWith('https://raw.githubusercontent.com/');
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'gajae-code-app',
      ...(github && githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function slugName(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
}

/** A generated entry must be installable and must not be a vendor namespace. */
function plainName(value) {
  const name = slugName(value);
  return name && BUNDLED_NAME.test(name) ? name : '';
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

/**
 * A remote install is only used when the source names an http/sse transport and
 * carries a real URL. Nothing is synthesized from a homepage.
 */
function marketplaceRemote(record) {
  const install = isRecord(record.install) ? record.install : {};
  const sources = [
    ['remote', install.remote],
    ['http', install.http],
    ['sse', install.sse],
    ['remote', record.remote],
  ];
  for (const [kind, block] of sources) {
    if (!isRecord(block) || typeof block.url !== 'string' || !/^https?:\/\//u.test(block.url)) continue;
    const declared = String(block.transport ?? block.type ?? kind).toLowerCase();
    return { url: block.url, transport: kind === 'sse' || declared.includes('sse') ? 'sse' : 'http' };
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

function fromMarketplace(record, name) {
  if (!isRecord(record)) return null;
  const command = marketplaceCommand(record);
  const remote = marketplaceRemote(record);
  if (!command && !remote) return null;
  const transports = Array.isArray(record.transports) ? record.transports.map(String) : [];
  const wantsRemote = transports.includes('http') || transports.includes('sse');
  const repository = repositoryUrl(record);
  const stars = typeof record.stars === 'number' && Number.isFinite(record.stars)
    && !SUBTREE_URL.test(repository ?? '') ? record.stars : undefined;
  const shared = {
    name,
    title: typeof record.name === 'string' ? record.name : undefined,
    description: String(record.tagline || record.description || '').trim(),
    ...(stars ? { stars } : {}),
    ...(typeof record.homepage === 'string' ? { homepage: record.homepage } : {}),
    ...(repository ? { repository: { url: repository, source: 'marketplace' } } : {}),
    origin: 'marketplace',
  };

  if (remote && (!command || wantsRemote)) {
    return { ...shared, transport: remote.transport, url: remote.url };
  }
  if (!command) return null;
  const pkg = packageFrom(command.command, command.args, name);
  return {
    ...shared,
    transport: 'stdio',
    command: command.command,
    args: command.args,
    ...(pkg ? { package: pkg } : {}),
    ...(envFrom(command.env) ? { env: envFrom(command.env) } : {}),
  };
}

function prettyName(value) {
  const acronyms = new Set(['ai', 'api', 'aws', 'cd', 'ci', 'gcp', 'k8s', 'mcp', 'ocr', 'rag', 's3', 'sql']);
  return value.split(/[-_]+/u).filter(Boolean).map((part) => (
    acronyms.has(part) ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`
  )).join(' ');
}

/**
 * Docker's MCP catalog is a second marketplace. A Docker Hub image is bundled
 * only if docker/mcp-registry publishes it, so an abandoned namespace squat is
 * not treated as a server.
 */
async function dockerEntries() {
  if (process.env.CATALOG_SKIP_DOCKER === '1') return { entries: [], skipped: 0 };
  const tree = await json(DOCKER_TREE_URL);
  const dirs = new Set(
    (Array.isArray(tree.tree) ? tree.tree : [])
      .map((entry) => (typeof entry?.path === 'string' ? entry.path : ''))
      .map((value) => /^servers\/([^/]+)\/server\.yaml$/u.exec(value)?.[1]?.toLowerCase())
      .filter(Boolean),
  );
  const images = [];
  let skipped = 0;
  // One page is enough for the recognizable images; deeper pages are rate-limited
  // anonymously, and the catalog does not want hundreds of Docker duplicates.
  const body = await json(`${DOCKER_HUB_URL}?page_size=100&page=1`);
  images.push(...(Array.isArray(body.results) ? body.results : []));
  const seen = new Set();
  return {
    skipped,
    entries: images
      .filter((image) => {
        const name = plainName(image?.name);
        if (!name || name === 'signatures' || !dirs.has(name)) { skipped += 1; return false; }
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      })
      .sort((a, b) => (b.pull_count ?? 0) - (a.pull_count ?? 0))
      .slice(0, DOCKER_LIMIT)
      .map((image) => ({
        name: image.name,
        title: prettyName(image.name),
        description: String(image.description ?? '').trim(),
        transport: 'stdio',
        command: 'docker',
        args: ['run', '-i', '--rm', `mcp/${image.name}`],
        package: { manager: 'other', name: `mcp/${image.name}` },
        popularity: typeof image.pull_count === 'number' ? image.pull_count : undefined,
        homepage: `https://hub.docker.com/r/mcp/${image.name}`,
        origin: 'marketplace',
      })),
  };
}

const starCache = new Map();
async function starsFor(url) {
  if (!url || SUBTREE_URL.test(url)) return undefined;
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

async function sourceJson(url, fileEnvironment) {
  const file = process.env[fileEnvironment];
  if (file) return JSON.parse(await readFile(file, 'utf8'));
  return json(url);
}

function reportText(details) {
  return [
    `- Marketplace records: ${details.marketplaceRecords} (${details.namespaced} namespaced, ${details.noCommand} without a runnable command)`,
    `- Docker images bundled: ${details.dockerEntries} (${details.dockerSkipped} skipped: no registry entry or namespaced)`,
    `- Duplicates collapsed: ${details.duplicates}`,
    `- Stars omitted for monorepo subdirectory URLs: ${details.subtreeStars}`,
    `- Curated entries merged last: ${details.curated}`,
    `- Stars re-fetched from GitHub: ${details.starsRefreshed} re-fetched, ${details.starsKept} kept after a failed lookup`,
  ].join('\n');
}

async function main() {
  console.log('fetching marketplace…');
  const marketplace = await sourceJson(MARKETPLACE_URL, 'CATALOG_MARKETPLACE_FILE');
  const seed = await sourceJson(SEED_URL, 'CATALOG_SEED_FILE').catch(() => ({ servers: [] }));
  const raw = [...(marketplace.servers ?? []), ...(seed.servers ?? [])];

  let namespaced = 0;
  let noCommand = 0;
  const marketplaceEntries = [];
  for (const record of raw) {
    const name = plainName(record?.slug || record?.name);
    if (!name) { namespaced += 1; continue; }
    const entry = fromMarketplace(record, name);
    if (!entry) { noCommand += 1; continue; }
    marketplaceEntries.push(entry);
  }

  const docker = await dockerEntries();
  const beforeDedupe = [...marketplaceEntries, ...docker.entries];
  const generated = dedupe(beforeDedupe);
  const duplicates = beforeDedupe.length - generated.length;

  let done = 0;
  let starsRefreshed = 0;
  let starsKept = 0;
  for (const entry of generated) {
    const repository = entry.repository?.url;
    if (!repository) continue;
    // A marketplace copy is a snapshot; always ask GitHub, and fall back to
    // the published number only when the lookup itself fails.
    const stars = await starsFor(repository);
    if (typeof stars === 'number') {
      entry.stars = stars;
      starsRefreshed += 1;
    } else if (typeof entry.stars === 'number') {
      starsKept += 1;
    }
    done += 1;
    if (done % 25 === 0) console.log(`stars ${done}/${generated.length}`);
  }

  const curatedRaw = JSON.parse(await readFile(path.join(root, 'data', 'catalog.curated.json'), 'utf8'));
  const curated = curatedRaw.map((entry) => ({ ...entry, origin: 'curated' }));
  if (process.env.CATALOG_SKIP_REMOTE_CHECK !== '1') {
    const remotes = curated.filter((entry) => entry.transport !== 'stdio');
    const failures = [];
    for (const entry of remotes) {
      if (!(await remoteAnswers(entry.url))) failures.push(entry.name);
    }
    if (failures.length > 0) {
      throw new Error(`curated remote endpoints did not answer without credentials: ${failures.join(', ')}`);
    }
    console.log(`verified ${remotes.length} curated remote endpoints`);
  }
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

  if (!Number.isFinite(MIN_ENTRIES) || merged.length < MIN_ENTRIES) {
    throw new Error(`refusing to write ${merged.length} entries; the floor is ${MIN_ENTRIES}. Add curated entries instead of padding with registry namespaces.`);
  }

  const subtreeStars = merged.filter((entry) => SUBTREE_URL.test(entry.repository?.url ?? '')).length;
  const details = {
    marketplaceRecords: raw.length,
    namespaced,
    noCommand,
    dockerEntries: docker.entries.length,
    dockerSkipped: docker.skipped,
    duplicates,
    subtreeStars,
    curated: curated.length,
    starsRefreshed,
    starsKept,
  };

  const output = `${JSON.stringify(merged, null, 2)}\n`;
  const outputRoot = process.env.CATALOG_OUTPUT_DIR ?? root;
  await mkdir(path.join(outputRoot, 'server', 'modules', 'mcp'), { recursive: true });
  await writeFile(path.join(outputRoot, 'server', 'modules', 'mcp', 'catalog.data.json'), output, 'utf8');
  await mkdir(path.join(outputRoot, 'deploy', 'mcp'), { recursive: true });
  await writeFile(path.join(outputRoot, 'deploy', 'mcp', 'catalog.json'), output, 'utf8');
  await writeFile(path.join(outputRoot, 'deploy', 'mcp', 'README.md'), `# Generated MCP catalog

Generated by \`scripts/build-mcp-catalog.mjs\`. Do not edit by hand.

- Marketplace: ${MARKETPLACE_URL} (MIT, generated ${marketplace.generatedAt ?? 'unknown'}, totalCount ${marketplace.totalCount ?? 'unknown'})
- Cross-check: ${SEED_URL}
- Docker: ${DOCKER_HUB_URL} (images cross-checked against docker/mcp-registry)
- Curated entries merged last: \`data/catalog.curated.json\`
- Output entries: ${merged.length}

${reportText(details)}

The bundled copy lives at \`server/modules/mcp/catalog.data.json\`; this file is
the same content, served as the curated overlay so the app can grow without a
new image. The official MCP registry is not bundled; it is queried at runtime.
Stars were re-fetched from the GitHub API at generation time, and a repository
URL under \`/tree/\` or \`/blob/\` never contributes a count. At request time the
runtime refreshes missing stars best-effort with a bounded, cached lookup; a
rate limit or missing token only omits the count.
`, 'utf8');
  console.log(reportText(details));
  console.log(`wrote ${merged.length} entries`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
