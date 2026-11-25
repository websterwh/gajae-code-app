import assert from 'node:assert/strict';
import test from 'node:test';

import { moveArgument, moveFolderListing } from './useMoveFolderSuggestions';

test('only a /move line with an optional, single-line argument suggests folders', () => {
  assert.equal(moveArgument('/move'), '');
  assert.equal(moveArgument('/move /workspace/app'), '/workspace/app');
  assert.equal(moveArgument('/move  ~/proj'), '~/proj');
  assert.equal(moveArgument('/moved'), null);
  assert.equal(moveArgument('/move a\nb'), null);
  assert.equal(moveArgument('hello /move /tmp'), null);
});

test('a bare name lists the session folder and filters by that name', () => {
  assert.deepEqual(moveFolderListing('torr', '/workspace/temp'), { directory: '/workspace/temp', prefix: 'torr' });
  assert.deepEqual(moveFolderListing('', '/workspace/temp'), { directory: '/workspace/temp', prefix: '' });
});

test('a partial path lists its parent and filters by the last segment', () => {
  assert.deepEqual(moveFolderListing('/workspace/ga', '/workspace/temp'), { directory: '/workspace', prefix: 'ga' });
  assert.deepEqual(moveFolderListing('/workspace/gajae-code/ap', null), { directory: '/workspace/gajae-code', prefix: 'ap' });
  assert.deepEqual(moveFolderListing('sub/di', '/workspace/temp'), { directory: '/workspace/temp/sub', prefix: 'di' });
});

test('a home-relative path is passed to the endpoint, which expands it', () => {
  assert.deepEqual(moveFolderListing('~/proj', '/workspace/temp'), { directory: '~', prefix: 'proj' });
  assert.deepEqual(moveFolderListing('~/a/b', '/workspace/temp'), { directory: '~/a', prefix: 'b' });
});
