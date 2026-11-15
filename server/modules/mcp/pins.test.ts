import assert from 'node:assert/strict';
import test from 'node:test';

import { isDowngrade, normalizePin, parsePackageSpec, pinnedSpec, shouldAutoUpdate } from './pins.js';

test('package specs parse by manager, including scoped npm and git sources', () => {
  assert.deepEqual(parsePackageSpec('@modelcontextprotocol/server-git@1.2.3'), {
    raw: '@modelcontextprotocol/server-git@1.2.3',
    name: '@modelcontextprotocol/server-git',
    version: '1.2.3',
    manager: 'npm',
  });
  assert.deepEqual(parsePackageSpec('serena==0.4.1'), {
    raw: 'serena==0.4.1', name: 'serena', version: '0.4.1', manager: 'pypi',
  });
  const git = parsePackageSpec('git+https://github.com/oraios/serena.git');
  assert.equal(git.manager, 'git');
  assert.equal(git.name, 'serena');
  assert.equal(parsePackageSpec('typescript').name, 'typescript');
});

test('latest is unresolved at rest, never a stored pin', () => {
  assert.equal(normalizePin('latest'), null);
  assert.equal(normalizePin('*'), null);
  assert.equal(normalizePin(''), null);
  assert.equal(normalizePin(undefined), null);
  assert.equal(normalizePin(' 1.2.3 '), '1.2.3');
});

test('a pin uses the manager syntax', () => {
  const uvSpec = parsePackageSpec('serena');
  assert.equal(pinnedSpec(uvSpec, '1.2.3', 'uv'), 'serena==1.2.3');
  const npmSpec = parsePackageSpec('typescript');
  assert.equal(pinnedSpec(npmSpec, '5.0.0', 'npm'), 'typescript@5.0.0');
  assert.equal(pinnedSpec(npmSpec, null, 'npm'), 'typescript');
  // A git checkout has no package version to pin.
  const git = parsePackageSpec('git+https://github.com/oraios/serena');
  assert.equal(pinnedSpec(git, '1.2.3', 'uv'), 'git+https://github.com/oraios/serena');
});

test('auto-update skips pinned packages and detects a downgrade', () => {
  assert.equal(shouldAutoUpdate(null), true);
  assert.equal(shouldAutoUpdate('1.2.3'), false);
  assert.equal(isDowngrade('2.0.0', '1.9.9'), true);
  assert.equal(isDowngrade('1.0.0', '2.0.0'), false);
  assert.equal(isDowngrade(null, '1.0.0'), false);
});
