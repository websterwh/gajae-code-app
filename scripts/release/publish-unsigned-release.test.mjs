import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { PACKAGE_NAME, REPOSITORY_SLUG } from '../../shared/productIdentity.js';

import { assetNames } from './updater-artifacts.mjs';
import { processUnsignedRelease, unsignedAssetNames } from './publish-unsigned-release.mjs';

const tag = 'v9.9.9';
const commit = 'a'.repeat(40);

async function fixture(t, { checksum = 'good', extra = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gajae-unsigned-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  const assets = join(root, 'assets');
  await mkdir(checkout);
  await mkdir(assets);
  await writeFile(join(checkout, 'package.json'),
    JSON.stringify({ name: PACKAGE_NAME, version: tag.slice(1) }));
  const names = assetNames({ productVersion: tag.slice(1), tag });
  const dmg = Buffer.from('dmg fixture bytes');
  const server = Buffer.from('server fixture bytes');
  const sha = buffer => createHash('sha256').update(buffer).digest('hex');
  await writeFile(join(assets, names.macos.dmg), dmg);
  await writeFile(join(assets, names.server.archive), server);
  await writeFile(join(assets, names.macos.dmgChecksum), `${sha(dmg)}  ${names.macos.dmg}\n`);
  const serverHash = checksum === 'bad' ? 'b'.repeat(64) : sha(server);
  await writeFile(join(assets, names.server.checksum), `${serverHash}  ${names.server.archive}\n`);
  if (extra) await writeFile(join(assets, 'unexpected.txt'), 'nope');
  return { checkout, assets, names, dmg, server, sha };
}

function fakeGitHub({ assets, names, dmg, server, sha, existing = [], draftId = 77,
  publishResponse, failUpload = false }) {
  const calls = [];
  const run = async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'git') return { stdout: `${commit}\n` };
    if (program !== 'gh') throw new Error(`Unexpected command: ${program}`);
    const [command, , host, target] = args;
    if (command !== 'api') throw new Error(`Unexpected gh command: ${command}`);
    if (host === 'uploads.github.com') {
      if (failUpload) throw new Error('upload exploded');
      const name = decodeURIComponent(target.split('name=')[1]);
      const bytes = name === names.macos.dmg ? dmg : name === names.server.archive ? server : null;
      if (bytes) {
        return { stdout: JSON.stringify({ id: calls.length, name, state: 'uploaded',
          size: bytes.length, digest: `sha256:${sha(bytes)}` }) };
      }
      const text = await readFile(join(assets, name), 'utf8');
      const hash = createHash('sha256').update(text).digest('hex');
      return { stdout: JSON.stringify({ id: calls.length, name, state: 'uploaded',
        size: Buffer.byteLength(text), digest: `sha256:${hash}` }) };
    }
    if (target.includes('git/matching-refs/tags/')) return { stdout: ' [[]]' };
    if (target.includes('releases?per_page=')) return { stdout: JSON.stringify(existing) };
    if (target.endsWith('/releases')) {
      return { stdout: JSON.stringify({ id: draftId, draft: true, tag_name: tag,
        target_commitish: commit, assets: [] }) };
    }
    if (target.endsWith(`/releases/${draftId}`)) {
      if (publishResponse !== undefined) return { stdout: JSON.stringify(publishResponse) };
      return { stdout: JSON.stringify({ id: draftId, draft: false, tag_name: tag,
        target_commitish: commit, assets: [] }) };
    }
    throw new Error(`Unexpected API path: ${target}`);
  };
  return { run, calls };
}

test('an unsigned release verifies four assets and uploads them into one draft', async t => {
  const data = await fixture(t);
  const github = fakeGitHub(data);
  const result = await processUnsignedRelease({
    repo: REPOSITORY_SLUG, tag, commit, assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run });
  assert.equal(result.status, 'verified-draft');
  assert.equal(result.uploadedCount, 4);
  assert.equal(result.signed, false);
  const uploaded = github.calls.filter(([, , , host]) => host === 'uploads.github.com');
  assert.deepEqual(uploaded.map(call => decodeURIComponent(call[4].split('name=')[1])),
    [...unsignedAssetNames({ productVersion: tag.slice(1), tag })]);
  assert.ok(!github.calls.some(call => call.includes('PATCH')));
});

test('--publish applies draft=false only after every upload verified', async t => {
  const data = await fixture(t);
  const github = fakeGitHub(data);
  const result = await processUnsignedRelease({
    repo: REPOSITORY_SLUG, tag, commit, assetsDirectory: data.assets,
    checkoutRoot: data.checkout, publish: true,
  }, { run: github.run });
  assert.equal(result.status, 'published');
  const publishCall = github.calls.find(call => call.includes('PATCH'));
  assert.ok(publishCall, 'expected one publication request');
  assert.deepEqual(publishCall.slice(-2), ['--field', 'draft=false']);
  const lastUpload = github.calls.findLastIndex(([, , , host]) => host === 'uploads.github.com');
  assert.ok(lastUpload >= 0 && lastUpload < github.calls.indexOf(publishCall));
});

test('a mismatched checksum sidecar is refused before any GitHub call', async t => {
  const data = await fixture(t, { checksum: 'bad' });
  const github = fakeGitHub(data);
  await assert.rejects(processUnsignedRelease({
    repo: REPOSITORY_SLUG, tag, commit, assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run }), /Checksum sidecar/);
  assert.deepEqual(github.calls.map(([program]) => program), ['git']);
});

test('the asset directory must hold exactly the four canonical files', async t => {
  const data = await fixture(t, { extra: true });
  const github = fakeGitHub(data);
  await assert.rejects(processUnsignedRelease({
    repo: REPOSITORY_SLUG, tag, commit, assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run }), /exactly the four unsigned release assets/);
});

test('an existing release with the tag is never overwritten', async t => {
  const data = await fixture(t);
  const github = fakeGitHub({ ...data, existing: [{ id: 5, tag_name: tag }] });
  await assert.rejects(processUnsignedRelease({
    repo: REPOSITORY_SLUG, tag, commit, assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run }), /already exists/);
  assert.ok(!github.calls.some(call => call.includes('--method')));
});

test('a failed upload reports the preserved draft instead of retrying', async t => {
  const data = await fixture(t);
  const github = fakeGitHub({ ...data, draftId: 91, failUpload: true });
  await assert.rejects(processUnsignedRelease({
    repo: REPOSITORY_SLUG, tag, commit, assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run }), error => error.draftId === 91);
  const uploads = github.calls.filter(([, , , host]) => host === 'uploads.github.com');
  assert.equal(uploads.length, 1, 'no upload retry');
});

test('the workflow repository is accepted and an unrelated repository is refused', async t => {
  const data = await fixture(t);
  const github = fakeGitHub(data);
  const fork = 'fork-owner/gajae-code-app';
  const result = await processUnsignedRelease({
    repo: fork, actionsRepository: fork, tag, commit,
    assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run });
  assert.equal(result.status, 'verified-draft');
  await assert.rejects(processUnsignedRelease({
    repo: 'someone-else/gajae-code-app', actionsRepository: fork, tag, commit,
    assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run }), /restricted to/);
  await assert.rejects(processUnsignedRelease({
    repo: 'not a slug', actionsRepository: fork, tag, commit,
    assetsDirectory: data.assets, checkoutRoot: data.checkout,
  }, { run: github.run }), /owner\/repo slug/);
});

test('a publication response that does not prove draft=false is rejected', async t => {
  const data = await fixture(t);
  const github = fakeGitHub({ ...data, publishResponse: { id: 77, draft: true, tag_name: tag,
    target_commitish: commit, assets: [] } });
  await assert.rejects(processUnsignedRelease({
    repo: REPOSITORY_SLUG, tag, commit, assetsDirectory: data.assets,
    checkoutRoot: data.checkout, publish: true,
  }, { run: github.run }), /Publication response is unexpected/);
});
