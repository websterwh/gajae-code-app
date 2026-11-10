import { runCommand } from './facts.mjs';

const TARGET = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/u;

/**
 * The host-side vocabulary.
 *
 * Nothing here is a shell. Each verb is one fixed command, and the only thing a
 * caller may influence is a target that has to match TARGET - so the server can
 * ask for "the status of container X" but cannot ask for an arbitrary command,
 * a flag or a pipeline. That is the whole allow-list.
 *
 * `mutating` verbs are declared but not enabled: they exist so the shape of the
 * eventual protocol is reviewable, while this build can only read the host.
 */
export const VERBS = [
  { id: 'host.info', summary: 'Kernel, distro, uptime', mutating: false, command: 'uname -a; cat /etc/os-release; uptime' },
  { id: 'host.disk', summary: 'Filesystem usage', mutating: false, command: 'df -hP -x tmpfs -x devtmpfs' },
  { id: 'host.memory', summary: 'Memory usage', mutating: false, command: 'free -m' },
  { id: 'host.network', summary: 'Interface addresses', mutating: false, command: 'ip -br addr' },
  { id: 'host.listeners', summary: 'Listening TCP/UDP sockets', mutating: false, command: 'ss -lntu' },
  { id: 'docker.ps', summary: 'Running containers', mutating: false, command: "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}'" },
  { id: 'docker.images', summary: 'Images on the host', mutating: false, command: "docker images --format 'table {{.Repository}}\\t{{.Tag}}\\t{{.Size}}'" },
  { id: 'docker.inspect', summary: 'State of one container', mutating: false, requiresTarget: 'container', command: (target) => `docker inspect --format '{{json .State}}' ${target}` },
  { id: 'service.status', summary: 'Status of one service', mutating: false, requiresTarget: 'service', command: (target) => `service ${target} status` },
  { id: 'docker.restart', summary: 'Restart one container', mutating: true, enabled: false, requiresTarget: 'container', command: (target) => `docker restart ${target}` },
  { id: 'service.restart', summary: 'Restart one service', mutating: true, enabled: false, requiresTarget: 'service', command: (target) => `service ${target} restart` },
];

export function resolveVerb(id, verbs = VERBS) {
  const verb = verbs.find((candidate) => candidate.id === id);
  if (!verb) {
    throw new Error(`UNKNOWN_VERB: ${id}. Known verbs: ${verbs.map((candidate) => candidate.id).join(', ')}`);
  }
  return verb;
}

export function describeVerbs(verbs = VERBS) {
  return verbs.map((verb) => ({
    id: verb.id,
    summary: verb.summary,
    mutating: verb.mutating,
    enabled: verb.mutating ? verb.enabled !== false : true,
    target: verb.requiresTarget ?? null,
  }));
}

export async function executeVerb(id, { target, allowMutating = false, run = runCommand, verbs = VERBS } = {}) {
  const verb = resolveVerb(id, verbs);
  if (verb.mutating && !allowMutating) {
    throw new Error(`VERB_NOT_ALLOWED: ${id} changes the host; it only runs with an explicit allow-mutating opt-in.`);
  }
  if (verb.mutating && verb.enabled === false) {
    throw new Error(`VERB_NOT_ENABLED: ${id} is declared but not switched on in this build; only read-only verbs execute.`);
  }
  if (verb.requiresTarget) {
    if (!target) throw new Error(`TARGET_REQUIRED: ${id} needs a ${verb.requiresTarget} name.`);
    if (!TARGET.test(target)) throw new Error(`INVALID_TARGET: ${JSON.stringify(target)} is not a plain ${verb.requiresTarget} name.`);
  }
  const command = typeof verb.command === 'function' ? verb.command(target) : verb.command;
  const result = await run(command);
  return { id, command, mutating: Boolean(verb.mutating), ...result };
}
