import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectUsageOverview } from '@/modules/stats/stats.service.js';

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: number };

// The daily series only keeps the last 30 days, so fixtures have to be recent.
const ACTIVITY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const ACTIVITY_DAY = ACTIVITY.slice(0, 10);

function assistant(usage: Usage, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'message',
    id: `assistant-${Math.random().toString(36).slice(2)}`,
    timestamp: ACTIVITY,
    cwd: '/workspace/alpha',
    message: { role: 'assistant', model: 'astra', provider: 'openai', usage, ...extra },
  });
}

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gjc-stats-'));
  const sessions = path.join(root, 'sessions');
  const project = path.join(sessions, '-workspace-alpha');
  await mkdir(project, { recursive: true });
  return { root: sessions, project };
}

test('usage is summed across transcripts, split by model and day', async () => {
  const { root, project } = await workspace();
  await writeFile(path.join(project, 'one.jsonl'), [
    JSON.stringify({ type: 'session', cwd: '/workspace/alpha' }),
    // A tool result line must not be parsed as usage.
    JSON.stringify({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'x'.repeat(50) }] } }),
    assistant({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126 }),
  ].join('\n'));
  await writeFile(path.join(project, 'two.jsonl'), [
    assistant({ input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: 0.25 }),
  ].join('\n'));

  const overview = await collectUsageOverview({ root, refresh: true });

  assert.equal(overview.totals.sessions, 2, 'each transcript with usage counts as a session');
  assert.equal(overview.totals.turns, 2);
  assert.equal(overview.totals.input, 140);
  assert.equal(overview.totals.output, 30);
  assert.equal(overview.totals.cacheRead, 5);
  assert.equal(overview.totals.total, 176);
  assert.equal(overview.totals.cost, 0.25);
  assert.deepEqual(overview.models.map((row) => [row.model, row.total, row.sessions]), [['astra', 176, 2]]);
  assert.deepEqual(
    overview.projects.map((row) => [row.path, row.sessions, row.total]),
    [['/workspace/alpha', 2, 176]],
  );
  assert.deepEqual(overview.daily, [{ date: ACTIVITY_DAY, total: 176, cost: 0.25 }]);
  assert.equal(overview.firstActivityAt, ACTIVITY_DAY);
});

test('a transcript without usage is not counted as a session', async () => {
  const { root, project } = await workspace();
  await writeFile(path.join(project, 'empty.jsonl'), JSON.stringify({ type: 'session', cwd: '/workspace/alpha' }));

  const overview = await collectUsageOverview({ root, refresh: true });

  assert.equal(overview.totals.sessions, 0);
  assert.equal(overview.totals.total, 0);
  assert.deepEqual(overview.models, []);
});

test('a missing sessions root is an empty history rather than an error', async () => {
  const overview = await collectUsageOverview({ root: path.join(os.tmpdir(), 'gjc-stats-missing-root'), refresh: true });

  assert.equal(overview.scanned.files, 0);
  assert.equal(overview.totals.total, 0);
  assert.equal(overview.firstActivityAt, null);
});
