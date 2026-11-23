import type { ToolDefinition } from '@gajae-code/coding-agent/extensibility/extensions/types';
import * as z from 'zod/v4';

import {
  dockerClient,
  isArchivePath,
  isContainerAction,
  isContainerName,
  type HostControlClient,
} from './gjc-docker-socket.js';
import { EXEC_VERBS, findExecVerb } from './gjc-container-exec-verbs.js';
import { detectHost } from './gjc-host-discovery.js';
import {
  matchesHostTarget,
  type HostCapability,
  type HostControlRunPolicy,
  type SshHostTarget,
} from './gjc-host-control-policy.js';
import {
  describeSshVerbs,
  findSshVerb,
  resolveSshCommand,
  runSshCommand,
} from './gjc-ssh-host.js';

/**
 * `host` - the native agent path to the Docker host.
 *
 * The `/api/host` routes exist for the Settings tab. The model does not need
 * them: this server already has the socket mount, so the tool speaks to the
 * daemon directly over it and skips the HTTP loopback entirely. What keeps the
 * surface narrow is the same thing that keeps the routes narrow - a named
 * method per operation, fixed exec verbs, and the operator's capability
 * switches plus allowed-container list, resolved on the server per run and
 * re-checked here on every call.
 *
 * The tool is only attached to a run when the server resolved a policy for it
 * (`readHostControlRunPolicy`), so an image without the env gate never exposes
 * it at all.
 */

/**
 * The actions this run is offered. SSH actions exist only when the endpoint is
 * configured: a deployment without SSH must not advertise a path that can only
 * fail. Docker actions stay listed because the policy itself only reaches here
 * when the socket exists, and their individual switches answer at call time.
 */
export function hostSchemaFor(policy: HostControlRunPolicy) {
  const sshActions = policy.ssh
    ? [
      z.strictObject({
        action: z.literal('ssh'),
        verb: z.string().min(1).max(64),
        target: z.string().min(1).max(64).optional(),
      }),
      z.strictObject({
        action: z.literal('host_shell'),
        command: z.string().min(1).max(8192),
        timeoutMs: z.number().int().min(1_000).max(300_000).optional(),
      }),
    ]
    : [];
  return z.discriminatedUnion('action', [...dockerActions, ...sshActions] as any);
}

const dockerActions = [
  z.strictObject({ action: z.literal('info') }),
  z.strictObject({ action: z.literal('containers') }),
  z.strictObject({ action: z.literal('discovery') }),
  z.strictObject({ action: z.literal('restart'), container: z.string().min(1).max(128) }),
  z.strictObject({
    action: z.literal('container_action'),
    container: z.string().min(1).max(128),
    operation: z.enum(['start', 'stop', 'restart', 'pause', 'unpause']),
  }),
  z.strictObject({ action: z.literal('exec'), container: z.string().min(1).max(128), verb: z.string().min(1).max(64) }),
  z.strictObject({
    action: z.literal('read_file'),
    container: z.string().min(1).max(128),
    path: z.string().min(1).max(4096),
  }),
];

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], ...(details ? { details } : {}) };
}

function jsonResult(value: unknown, details?: Record<string, unknown>) {
  return textResult(JSON.stringify(value, null, 2), details);
}

function describe(policy: HostControlRunPolicy): string {
  const verbs = EXEC_VERBS.map((verb) => `${verb.id} (${verb.summary})`).join(', ');
  const sshVerbs = describeSshVerbs().map((verb) => `${verb.id} (${verb.summary})`).join(', ');
  return [
    'Direct access to the Docker host that runs this app, over the daemon socket rather than the app\'s own HTTP API.',
    `Capabilities enabled for this run: ${policy.capabilities.join(', ')}. A capability that is off is refused with the switch that turns it on.`,
    `Allowed containers: ${policy.targets.join(', ') || 'none'}. exec, read_file and container_action reach only names matching that list; restart is the one named container the operator permitted.`,
    'info reads daemon facts, containers lists every container with image, state, mounts and compose labels, and discovery derives the host picture: which OS or appliance the daemon runs on (Unraid, MOS, Proxmox VE, OpenMediaVault, CasaOS, ZimaOS) with its evidence, compose stacks, containers that mount the daemon socket, and unmanaged containers.',
    `exec runs one fixed verb inside the named container - there is no command string: ${verbs}. read_file reads one absolute path out of that container (files up to 256 KiB, directories list).`,
    'Start with containers to find the name, then exec with network or processes, or read_file on the mounted configuration. Do not guess a container name; the list is authoritative.',
    ...(policy.ssh
      ? [`ssh runs one fixed verb on ${policy.ssh.user}@${policy.ssh.host}:${policy.ssh.port} over SSH, pinned to the host key the operator saved - no command string is involved: ${sshVerbs}. A read verb runs immediately; a write verb asks the user for approval before it runs${policy.sshWritePreauthorized ? ', except that the operator pre-authorized host writes in Settings' : ', even in a trusted permission mode'}. host_shell is the general path: it runs the shell command you write on that host as ${policy.ssh.user} - edit a file, install a package, drive compose, restart what no verb names. The command is passed unchanged as one argument to sh on the remote host, so heredocs and pipes work. It counts as a host write: it needs the hostWrite switch and asks the user for approval showing the exact command${policy.sshWritePreauthorized ? ', unless the operator pre-authorized host writes' : ', in every permission mode'}. Prefer the fixed verbs for reads, because those run without a question. Output is capped at 64 KiB; pass timeoutMs (up to 5 minutes) for slow work.`]
      : []),
  ].join(' ');
}

/** The words the app's own approval cards use, so a host write reads like them. */
const APPROVE_ONCE = 'Allow once';
const DENY = 'Deny';

type HostApprovalUI = {
  select(prompt: string, choices: string[], selectOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
};

export function createHostControlTool(
  policy: HostControlRunPolicy,
  {
    client,
    ui,
    run = runSshCommand,
  }: {
    client?: HostControlClient;
    ui?: HostApprovalUI;
    run?: typeof runSshCommand;
  } = {},
): ToolDefinition {
  let docker: HostControlClient | undefined = client;
  const socket = (): HostControlClient => {
    docker ??= dockerClient({ socketPath: policy.socketPath });
    return docker;
  };

  const requireCapability = (capability: HostCapability): void => {
    if (policy.capabilities.includes(capability)) return;
    throw new Error(
      `The host ${capability} capability is off for this run. Turn it on in Settings → Automation (host control) and start a new turn.`,
    );
  };

  /**
   * A host write is approved per call, whatever the run's permission mode is:
   * `bypass` is a consent-UX mode for the agent's own tools, and this one
   * reaches root on another machine. Only the operator's explicit prior
   * authorization in Settings skips this question.
   */
  const approveWrite = async (target: SshHostTarget, verb: string, remote?: string): Promise<void> => {
    if (!ui) {
      throw new Error(`The host write ${verb} needs the user's approval, but this run has no approval surface.`);
    }
    const where = `${target.user}@${target.host}`;
    const choice = await ui.select(
      `Allow the agent to run ${verb}${remote ? ` ${remote}` : ''} on ${where}?`,
      [APPROVE_ONCE, DENY],
    ).catch(() => undefined);
    if (choice !== APPROVE_ONCE) throw new Error(`The host write ${verb} was not approved.`);
  };

  /** A shell command is approved the same way, with the command itself on the card. */
  const approveShell = async (target: SshHostTarget, command: string): Promise<void> => {
    if (!ui) {
      throw new Error('host_shell needs the user\'s approval, but this run has no approval surface.');
    }
    const choice = await ui.select(
      `Allow the agent to run this command on ${target.user}@${target.host}?\n\n${command}`,
      [APPROVE_ONCE, DENY],
    ).catch(() => undefined);
    if (choice !== APPROVE_ONCE) throw new Error('The host command was not approved.');
  };

  const requireTarget = (capability: HostCapability, container: string): void => {
    requireCapability(capability);
    if (!isContainerName(container)) {
      throw new Error(`${JSON.stringify(container)} is not a valid container name.`);
    }
    if (!matchesHostTarget(policy.targets, container)) {
      throw new Error(
        `${JSON.stringify(container)} is not on the host-control Allowed containers list in Settings → Automation. Add a matching name or glob, then start a new turn.`,
      );
    }
  };

  const schema = hostSchemaFor(policy);

  return {
    name: 'host',
    label: 'Host',
    description: describe(policy),
    parameters: schema,
    concurrency: 'exclusive',
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = schema.parse(rawParams);
      switch (params.action) {
        case 'info':
          requireCapability('facts');
          return jsonResult({ info: await socket().info() }, { host: 'info' });

        case 'containers':
          requireCapability('containers');
          return jsonResult({ containers: await socket().list() }, { host: 'containers' });

        case 'discovery': {
          requireCapability('discovery');
          const [info, containers] = await Promise.all([socket().info(), socket().list()]);
          return jsonResult(
            { profile: detectHost({ info, containers, socketPath: policy.socketPath }) },
            { host: 'discovery' },
          );
        }

        case 'restart':
          // Like POST /api/host/containers/:name/restart: one named container,
          // its own switch, and deliberately not scoped by the allowed list.
          requireCapability('restart');
          if (!isContainerName(params.container)) {
            throw new Error(`${JSON.stringify(params.container)} is not a valid container name.`);
          }
          await socket().restart(params.container);
          return jsonResult({ restarted: true, container: params.container }, { host: 'restart' });

        case 'container_action':
          requireTarget('docker', params.container);
          if (!isContainerAction(params.operation)) {
            throw new Error('operation must be one of start, stop, restart, pause, unpause.');
          }
          await socket().action(params.container, params.operation);
          return jsonResult(
            { container: params.container, operation: params.operation, done: true },
            { host: 'container_action' },
          );

        case 'exec': {
          requireTarget('shell', params.container);
          const verb = findExecVerb(params.verb);
          if (!verb) {
            throw new Error(
              `Unknown verb ${JSON.stringify(params.verb)}. Known verbs: ${EXEC_VERBS.map((entry) => entry.id).join(', ')}.`,
            );
          }
          const result = await socket().exec(params.container, verb.command);
          return jsonResult(
            { container: params.container, verb: verb.id, command: verb.command.join(' '), ...result },
            { host: 'exec', verb: verb.id },
          );
        }

        case 'ssh': {
          if (!policy.ssh) {
            throw new Error(
              'SSH access is not configured. Add the host, user, private key and pinned host key in Settings → Automation (host control), then start a new turn.',
            );
          }
          const verb = findSshVerb(params.verb);
          if (!verb) {
            throw new Error(
              `Unknown SSH verb ${JSON.stringify(params.verb)}. Known verbs: ${describeSshVerbs().map((entry) => entry.id).join(', ')}.`,
            );
          }
          if (verb.mutating) {
            requireCapability('hostWrite');
            if (!policy.sshWritePreauthorized) await approveWrite(policy.ssh, verb.id, params.target);
          } else {
            requireCapability('hostRead');
          }
          const command = resolveSshCommand(verb, params.target);
          const result = await run(policy.ssh, command, { timeoutMs: verb.mutating ? 30_000 : 20_000 });
          return jsonResult(
            {
              host: policy.ssh.host,
              verb: verb.id,
              mutating: verb.mutating,
              command,
              target: params.target ?? null,
              ...result,
            },
            { host: 'ssh', verb: verb.id, mutating: verb.mutating },
          );
        }

        case 'host_shell': {
          if (!policy.ssh) {
            throw new Error(
              'SSH access is not configured. Add the host, user, private key and pinned host key in Settings → Automation (host control), then start a new turn.',
            );
          }
          // A command can read, write and install, so it is never a read verb:
          // the write switch and the per-call question both apply.
          requireCapability('hostWrite');
          if (params.command.includes('\u0000')) throw new Error('command must not contain a NUL byte.');
          if (!policy.sshWritePreauthorized) await approveShell(policy.ssh, params.command);
          const result = await run(policy.ssh, params.command, { timeoutMs: params.timeoutMs ?? 60_000 });
          return jsonResult(
            {
              host: policy.ssh.host,
              user: policy.ssh.user,
              command: params.command,
              ...result,
            },
            { host: 'host_shell' },
          );
        }

        case 'read_file': {
          requireTarget('files', params.container);
          if (!isArchivePath(params.path)) {
            throw new Error('path must be an absolute path with no ".." segment.');
          }
          const archive = await socket().archive(params.container, params.path);
          if (archive.kind === 'too-large') {
            throw new Error(`${JSON.stringify(archive.name)} is ${archive.size} bytes; the read limit is 256 KiB.`);
          }
          if (archive.kind === 'dir') {
            return jsonResult(
              { container: params.container, path: params.path, entries: archive.entries, truncated: archive.truncated },
              { host: 'read_file' },
            );
          }
          return jsonResult({
            container: params.container,
            path: params.path,
            name: archive.name,
            size: archive.size,
            encoding: 'utf8',
            content: archive.content.toString('utf8'),
            truncated: archive.truncated,
          }, { host: 'read_file' });
        }
      }
    },
  };
}
