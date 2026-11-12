#!/usr/bin/env node
// Publishes the unsigned macOS desktop release.
//
// This is the release shape that needs no Apple credentials: the DMG is
// ad-hoc signed by the bundle build, and macOS shows the "Open Anyway" prompt
// on first launch instead of accepting the app silently. Because there is no
// Developer ID there is no notarization ticket and no signed updater archive,
// so the release carries exactly four assets and the app ships with its
// updater compiled out.
//
// Usage: node scripts/release/publish-unsigned-release.mjs
//   --repo OWNER/REPO --tag vVERSION --commit FULL_SHA
//   --assets-dir DIRECTORY [--publish]
//
// Creates one empty generated-notes draft, uploads the four assets once, and
// only then applies draft=false. Never retries, replaces, deletes or rolls
// back; once GitHub returns a draft ID, every failure reports it.

import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { PACKAGE_NAME, REPOSITORY_SLUG } from '../../shared/productIdentity.js';

import { assetNames, UPDATER_ASSET_LIMITS } from './updater-artifacts.mjs';
import { releaseCommand } from './local-release-command.mjs';
import { assertChecksum } from './local-release.mjs';
import { readUpdaterSidecar } from './updater-signature.mjs';
import { resolveReleaseTag } from './updater-history.mjs';

const COMMIT = /^[a-f0-9]{40}$/;
const TAG = /^v\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/;
const PATH_CONTROL = /[\u0000-\u001f\u007f]/u;
const PAGE_SIZE = 100;
const MAX_MANIFEST_BYTES = UPDATER_ASSET_LIMITS.maxManifestBytes;

function demand(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safePath(value, label) {
  demand(typeof value === 'string' && value.length > 0 && !PATH_CONTROL.test(value),
    `${label} is missing or malformed.`);
  return resolve(value);
}

export function unsignedAssetNames({ productVersion, tag }) {
  const names = assetNames({ productVersion, tag });
  return Object.freeze([names.macos.dmg, names.macos.dmgChecksum,
    names.server.archive, names.server.checksum]);
}

function assetLimit(name, names) {
  if (name === names.macos.dmg) return UPDATER_ASSET_LIMITS.maxDmgBytes;
  if (name === names.server.archive) return UPDATER_ASSET_LIMITS.maxPayloadBytes;
  if (name.endsWith('.sha256')) return UPDATER_ASSET_LIMITS.maxChecksumBytes;
  throw new Error(`Unrecognized release asset: ${name}`);
}

async function hashFile(path, maxBytes, label) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new Error(`${label} must be a readable regular file.`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const metadata = await file.stat();
    demand(metadata.isFile(), `${label} must be a regular file.`);
    demand(metadata.size > 0 && metadata.size <= maxBytes, `${label} is empty or oversized.`);
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      demand(bytes <= maxBytes, `${label} exceeded its size limit.`);
      hash.update(chunk);
    }
    demand(bytes === metadata.size, `${label} changed while reading.`);
  } finally {
    await file.close();
  }
  return { path, size: bytes, hash: hash.digest('hex') };
}

async function inspectAssets(assetsDirectory, names) {
  const expected = unsignedAssetNames(names);
  let entries;
  try {
    entries = await readdir(assetsDirectory, { withFileTypes: true });
  } catch {
    throw new Error('Assets directory must be readable.');
  }
  demand(entries.length === expected.length,
    'Assets directory must contain exactly the four unsigned release assets.');
  const metadata = new Map();
  for (const entry of entries) {
    demand(entry.isFile() && SAFE_NAME.test(entry.name) && expected.includes(entry.name),
      'Assets directory contains an unexpected or non-regular file.');
    demand(!metadata.has(entry.name), `Duplicate release asset name: ${entry.name}`);
    metadata.set(entry.name, await hashFile(join(assetsDirectory, entry.name),
      assetLimit(entry.name, names), `Release asset ${entry.name}`));
  }
  for (const name of expected) demand(metadata.has(name), `Missing release asset: ${name}`);
  for (const [name, checksumName] of [
    [names.macos.dmg, names.macos.dmgChecksum],
    [names.server.archive, names.server.checksum],
  ]) {
    const checksum = await readUpdaterSidecar(metadata.get(checksumName).path,
      UPDATER_ASSET_LIMITS.maxChecksumBytes);
    assertChecksum(checksum, name, metadata.get(name).hash);
  }
  return metadata;
}

function validateOptions({ repo, tag, commit, assetsDirectory, publish = false,
  checkoutRoot = process.cwd() }) {
  demand(repo === REPOSITORY_SLUG, `Release repository is restricted to ${REPOSITORY_SLUG}.`);
  demand(TAG.test(tag ?? ''), 'Explicit canonical release tag is required.');
  demand(COMMIT.test(commit ?? ''), 'Explicit full lowercase 40-character commit is required.');
  demand(typeof publish === 'boolean', 'Publish must be boolean.');
  const productVersion = tag.slice(1);
  const names = assetNames({ productVersion, tag });
  return {
    repo,
    tag,
    commit,
    publish,
    productVersion,
    names,
    assetsDirectory: safePath(assetsDirectory, 'Assets directory'),
    checkoutRoot: safePath(checkoutRoot, 'Checkout directory'),
  };
}

async function readCheckoutVersion(checkoutRoot) {
  const packageJson = await readUpdaterSidecar(join(checkoutRoot, 'package.json'), MAX_MANIFEST_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    throw new Error('Checkout package.json must contain valid JSON.');
  }
  demand(isRecord(parsed) && parsed.name === PACKAGE_NAME,
    'Checkout package.json has an unexpected package name.');
  demand(typeof parsed.version === 'string' && parsed.version.length > 0,
    'Checkout package.json is missing its version.');
  return parsed.version;
}

function encodedAssetUrl(repo, draftId, name) {
  return `https://uploads.github.com/repos/${repo}/releases/${draftId}/assets?name=${encodeURIComponent(name)}`;
}

function attachDraftId(error, draftId) {
  if (draftId !== undefined && error && typeof error === 'object') {
    Object.defineProperty(error, 'draftId', { value: draftId, enumerable: true, configurable: true });
  }
  return error;
}

export async function processUnsignedRelease({
  repo,
  tag,
  commit,
  assetsDirectory,
  publish = false,
  checkoutRoot = process.cwd(),
} = {}, { run = releaseCommand } = {}) {
  const options = validateOptions({ repo, tag, commit, assetsDirectory, publish, checkoutRoot });
  demand(typeof run === 'function', 'Release command dependency is invalid.');
  const api = async (path, args = []) => {
    const result = await run('gh', ['api', '--hostname', 'github.com',
      `repos/${options.repo}/${path}`, ...args]);
    demand(isRecord(result) && typeof result.stdout === 'string',
      'GitHub API request returned an invalid result.');
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error('GitHub API response must contain valid JSON.');
    }
  };

  const checkoutVersion = await readCheckoutVersion(options.checkoutRoot);
  demand(`v${checkoutVersion}` === options.tag,
    'Checkout product version does not match the explicit release tag.');
  const head = await run('git', ['-C', options.checkoutRoot, 'rev-parse', 'HEAD']);
  demand(isRecord(head) && typeof head.stdout === 'string'
    && head.stdout.trim() === options.commit,
  'Checkout HEAD does not match the explicit release commit.');

  const metadata = await inspectAssets(options.assetsDirectory, options.names);
  const names = unsignedAssetNames(options.names);

  let draftId;
  try {
    let page = 1;
    const pages = new Set();
    for (;;) {
      const releases = await api(`releases?per_page=${PAGE_SIZE}&page=${page}`);
      demand(Array.isArray(releases) && releases.length <= PAGE_SIZE,
        'Existing release lookup response must be a bounded array.');
      const fingerprint = JSON.stringify(releases.map(release => [release?.id, release?.tag_name]));
      demand(!pages.has(fingerprint), 'Existing release lookup returned a repeated page.');
      pages.add(fingerprint);
      for (const release of releases) {
        demand(isRecord(release) && Number.isSafeInteger(release.id) && release.id > 0,
          'Existing release lookup contains a malformed record.');
        demand(release.tag_name !== options.tag,
          'A release with the explicit tag already exists.');
      }
      if (releases.length < PAGE_SIZE) break;
      page += 1;
    }
    await resolveReleaseTag({ tag: options.tag, expectedCommit: options.commit, allowAbsent: true }, api);

    const created = await api('releases', [
      '--method', 'POST',
      '--field', `tag_name=${options.tag}`,
      '--field', `target_commitish=${options.commit}`,
      '--field', 'draft=true',
      '--field', `prerelease=${options.productVersion.includes('-')}`,
      '--field', 'generate_release_notes=true',
    ]);
    draftId = created?.id;
    demand(isRecord(created) && Number.isSafeInteger(created.id) && created.id > 0,
      'Draft creation returned no trustworthy draft ID; inspect GitHub before any retry.');
    demand(created.draft === true && created.tag_name === options.tag
      && created.target_commitish === options.commit
      && Array.isArray(created.assets) && created.assets.length === 0,
    'Draft creation response does not prove an empty draft; inspect GitHub before any retry.');

    const uploaded = new Set();
    for (const name of names) {
      const expected = metadata.get(name);
      const response = await run('gh', [
        'api', '--hostname', 'uploads.github.com', encodedAssetUrl(options.repo, draftId, name),
        '--method', 'POST', '--input', expected.path,
        '--header', 'Content-Type: application/octet-stream',
      ]);
      let asset;
      try {
        asset = JSON.parse(response.stdout);
      } catch {
        throw new Error(`Upload ${name} response must contain valid JSON.`);
      }
      demand(isRecord(asset) && Number.isSafeInteger(asset.id) && asset.id > 0,
        `Upload ${name} response must be an object with a numeric ID.`);
      demand(!uploaded.has(asset.id), `Duplicate uploaded asset ID: ${asset.id}`);
      uploaded.add(asset.id);
      demand(asset.name === name && asset.state === 'uploaded'
        && asset.size === expected.size && asset.digest === `sha256:${expected.hash}`,
      `Upload ${name} response does not match the staged asset.`);
    }

    if (options.publish) {
      let published;
      try {
        published = await api(`releases/${draftId}`, ['--method', 'PATCH', '--field', 'draft=false']);
      } catch {
        throw Object.assign(new Error(
          'Publication request failed; inspect the exact release ID before any retry.'),
        { publicationMayHaveOccurred: true });
      }
      demand(isRecord(published) && published.id === draftId && published.draft === false
        && published.tag_name === options.tag
        && published.target_commitish === options.commit,
      'Publication response is unexpected; inspect the exact release ID and assets.');
    }

    return {
      status: options.publish ? 'published' : 'verified-draft',
      repo: options.repo,
      tag: options.tag,
      commit: options.commit,
      draftId,
      uploadedCount: uploaded.size,
      signed: false,
      note: 'Unsigned ad-hoc desktop build: Gatekeeper requires Open Anyway on first launch. No updater assets are published.',
    };
  } catch (error) {
    if (error && typeof error === 'object' && error.publicationMayHaveOccurred === true
      && error.outcomeStatus === undefined) {
      error.outcomeStatus = 'publication-outcome-unknown';
    }
    throw attachDraftId(error, draftId);
  }
}

const usage = `Usage: node scripts/release/publish-unsigned-release.mjs
  --repo ${REPOSITORY_SLUG} --tag vVERSION --commit FULL_SHA
  --assets-dir DIRECTORY [--publish]

Uploads exactly the DMG, its checksum and the server archive with its checksum
into one generated-notes draft. Draft-only by default; --publish then sets
draft=false on that exact release. Never retries, replaces or deletes.
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: {
      ...Object.fromEntries(['repo', 'tag', 'commit', 'assets-dir'].map(name => [name, { type: 'string' }])),
      publish: { type: 'boolean' }, help: { type: 'boolean' },
    } }));
    if (values.help) {
      process.stdout.write(usage);
      return;
    }
    demand(values.repo && values.tag && values.commit && values['assets-dir'],
      'All explicit release arguments are required.');
  } catch {
    process.stderr.write(usage);
    process.exitCode = 2;
    return;
  }
  try {
    const result = await processUnsignedRelease({
      repo: values.repo,
      tag: values.tag,
      commit: values.commit,
      assetsDirectory: values['assets-dir'],
      publish: values.publish === true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const unknown = error?.publicationMayHaveOccurred === true
      || error?.outcomeStatus === 'publication-outcome-unknown';
    process.stderr.write(`${JSON.stringify({
      status: unknown
        ? 'publication-outcome-unknown'
        : (error?.draftId === undefined ? 'blocked' : 'draft-preserved'),
      error: unknown
        ? 'Publication outcome is unknown; inspect the release before any retry.'
        : 'Unsigned release failed; inspect the reported draft before any retry.',
      ...(error?.draftId === undefined ? {} : { draftId: error.draftId }),
    })}\n`);
    process.exitCode = 1;
  }
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) await main();
