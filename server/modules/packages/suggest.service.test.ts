import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { CommandRunner } from '../mcp/index.js';

import { PackageSuggestService } from './suggest.service.js';

const aptRunner: CommandRunner = async (command, args) => {
  if (command !== 'apt-cache') return { code: 1, stdout: '', stderr: 'not found' };
  assert.deepEqual(args, ['search', '--names-only', 'zox']);
  return { code: 0, stdout: 'fzf - fuzzy finder\nzoxide - A smarter cd command\nzoxide-doc - docs\n', stderr: '' };
};

const offline = async (): Promise<never> => { throw new Error('offline'); };

describe('package suggestions', () => {
  test('merges apt, npm and PyPI and ranks name prefixes first', async () => {
    const service = new PackageSuggestService({
      runner: aptRunner,
      fetchImpl: async (url) => {
        if (url.includes('registry.npmjs.org')) {
          return { ok: true, json: async () => ({ objects: [{ package: { name: 'zoxide', description: 'npm wrapper' } }] }) };
        }
        return { ok: true, json: async () => ({ info: { name: 'zoxide', summary: 'pypi wrapper' } }) };
      },
    });

    const suggestions = await service.suggest('zox');

    // Prefix matches first; the unrelated apt hit (fzf) sorts last.
    assert.deepEqual(suggestions.map((suggestion) => `${suggestion.manager}:${suggestion.name}`), [
      'apt:zoxide',
      'npm:zoxide',
      'pip:zoxide',
      'apt:zoxide-doc',
      'apt:fzf',
    ]);
  });

  test('a source that is offline does not empty the whole list', async () => {
    const service = new PackageSuggestService({ runner: aptRunner, fetchImpl: offline });
    const suggestions = await service.suggest('zox');
    assert.ok(suggestions.length > 0);
    assert.ok(suggestions.every((suggestion) => suggestion.manager === 'apt'));
  });

  test('one character is not a search', async () => {
    let called = false;
    const service = new PackageSuggestService({
      runner: async () => { called = true; return { code: 0, stdout: '', stderr: '' }; },
      fetchImpl: offline,
    });
    assert.deepEqual(await service.suggest('z'), []);
    assert.equal(called, false);
  });
});
