/**
 * The scoped shell.
 *
 * There is no command string here and no way to pass one: a caller names a verb,
 * and the verb is one fixed argv. That is the allow-list - adding an ability is
 * a reviewable line in this table, not a new runtime grant. Nothing here reads
 * environment variables, because a container's environment is where its secrets
 * live, and nothing writes.
 *
 * These run *inside a named container*, which is what the Docker socket can do
 * without becoming root on the host. A host shell would need a privileged
 * container with the host mounted, i.e. exactly the escalation this feature is
 * meant to avoid; `deploy/host/gajae-host.mjs` over SSH remains the host-side
 * path.
 */
export type ExecVerb = {
  id: string;
  summary: string;
  command: readonly string[];
};

export const EXEC_VERBS: readonly ExecVerb[] = [
  { id: 'os', summary: 'Distribution name and version', command: ['cat', '/etc/os-release'] },
  { id: 'uptime', summary: 'Uptime and load average', command: ['uptime'] },
  // /proc instead of `free`: procps is not installed in most slim images.
  { id: 'memory', summary: 'Memory and swap counters', command: ['cat', '/proc/meminfo'] },
  { id: 'processes', summary: 'Process list', command: ['ps', 'aux'] },
  { id: 'disk', summary: 'Mounted filesystems and their use', command: ['df', '-h'] },
  { id: 'root', summary: 'Top-level directories', command: ['ls', '-la', '/'] },
  { id: 'network', summary: 'Interface addresses and routes', command: ['ip', 'addr'] },
];

export function findExecVerb(id: unknown): ExecVerb | undefined {
  if (typeof id !== 'string') return undefined;
  return EXEC_VERBS.find((verb) => verb.id === id);
}

export function describeExecVerbs(): Array<{ id: string; summary: string; command: string }> {
  return EXEC_VERBS.map((verb) => ({ id: verb.id, summary: verb.summary, command: verb.command.join(' ') }));
}
