import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  SHELL_RUN_MAX_TIMEOUT_MS,
  SHELL_RUN_MIN_TIMEOUT_MS,
  ShellRunRequestError,
  parseShellRunRequest,
  runShellCommand,
} from './shell-run.service.js';

const posixOnly = process.platform === 'win32' ? { skip: 'POSIX shell semantics' } : {};

test('runs the command inside the requested directory and keeps its output', posixOnly, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shell-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'marker.txt'), 'x');

  const result = await runShellCommand({ command: 'test -f marker.txt && printf found', cwd: root });

  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, root);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
  assert.match(result.output, /found/u);
});

test('a failing command reports its exit code and both streams', posixOnly, async () => {
  const result = await runShellCommand({ command: 'printf out; printf err >&2; exit 3' });

  assert.equal(result.exitCode, 3);
  assert.match(result.output, /out/u);
  assert.match(result.output, /err/u);
  assert.equal(result.timedOut, false);
});

test('a command that outlives its timeout is killed and says so', posixOnly, async () => {
  const result = await runShellCommand({ command: 'sleep 30', timeoutMs: SHELL_RUN_MIN_TIMEOUT_MS });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.durationMs >= SHELL_RUN_MIN_TIMEOUT_MS - 100, 'the timeout is what ended it');
});

test('an empty command, a NUL byte and a missing directory are refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shell-run-bad-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // Bad input is rejected before any child starts, so the call throws rather
  // than returning a promise; async wrappers keep assert.rejects in charge of it.
  await assert.rejects(async () => runShellCommand({ command: '   ' }), ShellRunRequestError);
  await assert.rejects(async () => runShellCommand({ command: 'ls\u0000' }), ShellRunRequestError);
  await assert.rejects(
    async () => runShellCommand({ command: 'ls', cwd: join(root, 'not-here') }),
    ShellRunRequestError,
  );
});

test('the timeout is clamped to the documented range', () => {
  assert.equal(parseShellRunRequest({ command: ' ls ' }).command, 'ls');
  assert.equal(parseShellRunRequest({ command: 'ls', timeoutMs: 10 }).timeoutMs, SHELL_RUN_MIN_TIMEOUT_MS);
  assert.equal(parseShellRunRequest({ command: 'ls', timeoutMs: 999_999 }).timeoutMs, SHELL_RUN_MAX_TIMEOUT_MS);
  assert.equal(parseShellRunRequest({ command: 'ls' }).cwd, process.cwd());
});
