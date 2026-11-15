import assert from 'node:assert/strict';
import test from 'node:test';

import { adoptSeeds, emptyDesired, upsertDesired } from './desired.js';

const NOW = '2026-01-01T00:00:00.000Z';

test('env seeds are adopted once, then left alone', () => {
  const state = emptyDesired();
  assert.equal(adoptSeeds(state, [{ manager: 'uv', spec: 'serena' }, { manager: 'aqua', spec: 'skylot/jadx' }], NOW), true);
  assert.equal(state.packages.uv.serena.spec, 'serena');
  assert.equal(state.packages.uv.serena.addedAt, NOW);
  assert.equal(state.packages.aqua['skylot/jadx'].spec, 'skylot/jadx');
  assert.equal(adoptSeeds(state, [{ manager: 'uv', spec: 'serena' }], 'later'), false);
});

test('an existing desired entry keeps its pin', () => {
  const state = emptyDesired();
  upsertDesired(state, { manager: 'uv', name: 'serena', spec: 'serena', pin: '1.0.0', addedAt: NOW });
  assert.equal(adoptSeeds(state, [{ manager: 'uv', spec: 'serena' }], 'later'), false);
  assert.equal(state.packages.uv.serena.pin, '1.0.0');
});
