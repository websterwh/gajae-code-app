// Stages the matching agent-desktop release into `release/agent-desktop/<target>/`
// so `build-agent-desktop-companion.mjs` can package it next to the companion.
//
// This is the release-side half of "bundle the driver into the companion": the
// companion itself no longer needs `--install-agent-desktop` (or Node, npm, or a
// PATH change) once agent-desktop sits beside it. Mirrors `companion-rs/src/
// install.rs`'s asset naming and checksum verification exactly - if one changes,
// the other has to change too.
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const RELEASES_API = 'https://api.github.com/repos/vercel-labs/agent-desktop/releases/latest';

/** Companion target name -> agent-desktop release target triple. */
const TARGETS = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'windows-x64': 'x86_64-pc-windows-msvc',
};

const requested = process.argv.slice(2);
if (!requested.length) throw new Error(`Pass at least one target: ${Object.keys(TARGETS).join(', ')}`);
for (const name of requested) {
  if (!TARGETS[name]) throw new Error(`Unknown target "${name}". Known: ${Object.keys(TARGETS).join(', ')}`);
}

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'gajae-agent-desktop-companion-release' } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const releaseResponse = await fetch(RELEASES_API, { headers: { 'User-Agent': 'gajae-agent-desktop-companion-release' } });
if (!releaseResponse.ok) throw new Error(`GitHub releases API returned HTTP ${releaseResponse.status}`);
const release = await releaseResponse.json();
const version = release.tag_name;
const assets = Array.isArray(release.assets) ? release.assets : [];
const checksumsAsset = assets.find((asset) => asset.name === 'checksums.txt');
if (!checksumsAsset) throw new Error(`release ${version} has no checksums.txt`);

for (const name of requested) {
  const triple = TARGETS[name];
  const assetName = `agent-desktop-${version}-${triple}.tar.gz`;
  const asset = assets.find((candidate) => candidate.name === assetName);
  if (!asset) throw new Error(`release ${version} has no asset named ${assetName}`);

  const [tarball, checksums] = await Promise.all([
    download(asset.browser_download_url),
    download(checksumsAsset.browser_download_url),
  ]);
  const expected = checksums.toString('utf8').split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[1] === assetName)?.[0];
  if (!expected) throw new Error(`checksums.txt has no entry for ${assetName}`);
  const actual = createHash('sha256').update(tarball).digest('hex');
  if (actual !== expected.toLowerCase()) {
    throw new Error(`checksum mismatch for ${assetName}: expected ${expected}, got ${actual}`);
  }

  const target = join('release', 'agent-desktop', name);
  await mkdir(target, { recursive: true });
  const archive = join(target, assetName);
  await writeFile(archive, tarball);
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', target], { stdio: 'inherit' });
  await rm(archive, { force: true });
  if (extracted.status !== 0) throw new Error(`failed to extract ${assetName} (exit ${extracted.status})`);
  console.log(`Staged agent-desktop ${version} (${triple}) into ${target}`);
}
