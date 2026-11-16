/**
 * The message `/run` renders for one finished command.
 *
 * Kept out of the composer so it can be checked without a DOM: the header has
 * to stay readable when the command contains backticks, and the body has to
 * survive output that itself contains a code fence.
 */

export type ShellRunOutput = {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  output: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

export function formatShellDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown time';
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function statusText(result: ShellRunOutput): string {
  if (result.timedOut) return 'timed out';
  if (result.exitCode === 0) return 'exit 0';
  if (result.exitCode !== null) return `exit ${result.exitCode}`;
  return result.signal ? `killed by ${result.signal}` : 'no exit status';
}

/** Inline code that still renders when the value itself contains a backtick. */
const inline = (value: string): string => value.includes('`') ? `\`\` ${value} \`\`` : `\`${value}\``;

/** A fence longer than any backtick run in the body, so the body cannot end it. */
function fenceFor(body: string): string {
  const longest = (body.match(/`+/gu) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

export function formatShellRun(result: ShellRunOutput): string {
  const output = result.output.replace(/\s+$/u, '');
  const fence = fenceFor(output);
  const parts = [
    `${inline(`/run ${result.command}`)} in ${inline(result.cwd)} — ${statusText(result)}, ${formatShellDuration(result.durationMs)}`,
    '',
    output ? `${fence}text\n${output}\n${fence}` : '_No output._',
  ];
  if (result.truncated) parts.push('', '_Output was truncated._');
  return parts.join('\n');
}
