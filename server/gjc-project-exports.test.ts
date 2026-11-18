import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  projectExportsFilePath,
  projectExportsFor,
  readProjectExports,
  recordProjectExport,
  type ProjectExportRecord,
} from './gjc-project-exports.js';

const record = (overrides: Partial<ProjectExportRecord> = {}): ProjectExportRecord => ({
  path: '/work/alpha/gjc-session-one.html',
  projectPath: '/work/alpha',
  sessionId: 'session-1',
  at: '2026-11-01T10:00:00.000Z',
  ...overrides,
});

test('the record lives beside the agent config so it survives a recreate', () => {
  assert.equal(
    projectExportsFilePath({ GJC_WORKER_AGENT_DIR: '/root/.gjc/agent' }),
    '/root/.gjc/agent/exports.jsonl',
  );
});

test('a recorded export reads back, and a missing file is an empty list rather than an error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'exports-'));
  try {
    const env = { GJC_WORKER_AGENT_DIR: path.join(root, 'agent') };
    assert.deepEqual(await readProjectExports(projectExportsFilePath(env)), []);

    await recordProjectExport(record(), env);
    await recordProjectExport(record({ path: '/work/alpha/second.html', at: '2026-11-02T10:00:00.000Z' }), env);

    assert.deepEqual(
      (await readProjectExports(projectExportsFilePath(env))).map((entry) => entry.path),
      ['/work/alpha/gjc-session-one.html', '/work/alpha/second.html'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a truncated line costs that line only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'exports-'));
  try {
    const file = path.join(root, 'exports.jsonl');
    await writeFile(file, `${JSON.stringify(record())}\n{"path": "/half\n${JSON.stringify(record({ path: '/work/alpha/two.html' }))}\n`, 'utf8');

    assert.deepEqual(
      (await readProjectExports(file)).map((entry) => entry.path),
      ['/work/alpha/gjc-session-one.html', '/work/alpha/two.html'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a project sees its directory and its own session, never another project', () => {
  const records = [
    record(),
    record({ path: '/work/beta/out.html', projectPath: '/work/beta', sessionId: 'session-2' }),
    // A session running in a worktree writes outside the project directory, so
    // only that session reaches its own export.
    record({ path: '/work/alpha-worktrees/one/export.html', projectPath: '/work/alpha-worktrees/one', sessionId: 'session-1' }),
    record({ path: '/work/beta/secret.html', projectPath: '/work/beta', sessionId: 'session-2' }),
  ];

  assert.deepEqual(
    projectExportsFor(records, { projectPath: '/work/alpha', sessionId: 'session-3' }).map((entry) => entry.path),
    ['/work/alpha/gjc-session-one.html'],
  );
  assert.deepEqual(
    projectExportsFor(records, { projectPath: '/work/alpha', sessionId: 'session-1' }).map((entry) => entry.path),
    // Same timestamp, so the order is the order the records were written.
    ['/work/alpha/gjc-session-one.html', '/work/alpha-worktrees/one/export.html'],
  );
});

test('an absolute destination is still that project\'s export', () => {
  assert.deepEqual(
    projectExportsFor([record({ path: '/tmp/elsewhere.html' })], { projectPath: '/work/alpha', sessionId: null }).map((entry) => entry.path),
    ['/tmp/elsewhere.html'],
  );
});

test('exporting the same file twice is one row carrying the newest record', () => {
  const records = [
    record({ at: '2026-11-01T10:00:00.000Z' }),
    record({ at: '2026-11-03T10:00:00.000Z' }),
  ];

  const rows = projectExportsFor(records, { projectPath: '/work/alpha' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.at, '2026-11-03T10:00:00.000Z');
});
