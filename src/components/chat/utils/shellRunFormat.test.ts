import assert from 'node:assert/strict';
import test from 'node:test';

import { formatShellDuration, formatShellRun, type ShellRunOutput } from './shellRunFormat';

const finished = (overrides: Partial<ShellRunOutput> = {}): ShellRunOutput => ({
  command: 'adb devices',
  cwd: '/repos/app',
  exitCode: 0,
  signal: null,
  output: 'List of devices attached\n',
  truncated: false,
  timedOut: false,
  durationMs: 120,
  ...overrides,
});

test('a finished command shows its exit status, directory and output', () => {
  const message = formatShellRun(finished());

  assert.match(message, /`\/run adb devices` in `\/repos\/app`/u);
  assert.match(message, /exit 0, 120ms/u);
  assert.match(message, /```text\nList of devices attached\n```/u);
});

test('a non-zero exit names the code', () => {
  assert.match(formatShellRun(finished({ exitCode: 2 })), /exit 2/u);
});

test('a timeout is named instead of an exit code', () => {
  const message = formatShellRun(finished({ exitCode: null, timedOut: true, durationMs: 30_000 }));

  assert.match(message, /timed out, 30\.0s/u);
  assert.doesNotMatch(message, /exit 0/u);
});

test('a killed command names its signal', () => {
  assert.match(formatShellRun(finished({ exitCode: null, signal: 'SIGKILL' })), /killed by SIGKILL/u);
});

test('output that contains a fence stays inside a longer one', () => {
  const message = formatShellRun(finished({ command: 'cat notes.md', output: 'before\n```js\nx\n```\nafter' }));

  assert.match(message, /````text\nbefore\n```js\nx\n```\nafter\n````/u);
});

test('a command containing a backtick still renders as inline code', () => {
  assert.match(formatShellRun(finished({ command: 'echo `date`' })), /`` \/run echo `date` ``/u);
});

test('empty output is said out loud, and truncation is flagged', () => {
  assert.match(formatShellRun(finished({ output: ' \n' })), /_No output\._/u);
  assert.match(formatShellRun(finished({ truncated: true })), /_Output was truncated\._/u);
});

test('durations past a minute stay readable', () => {
  assert.equal(formatShellDuration(980), '980ms');
  assert.equal(formatShellDuration(12_345), '12.3s');
});
