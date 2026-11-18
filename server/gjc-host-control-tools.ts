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
} from './gjc-host-control-policy.js';

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

const hostSchema = z.discriminatedUnion('action', [
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
]);

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text }], ...(details ? { details } : {}) };
}

function jsonResult(value: unknown, details?: Record<string, unknown>) {
  return textResult(JSON.stringify(value, null, 2), details);
}

function describe(policy: HostControlRunPolicy): string {
  const verbs = EXEC_VERBS.map((verb) => `${verb.id} (${verb.summary})`).join(', ');
  return [
    'Direct access to the Docker host that runs this app, over the daemon socket rather than the app\'s own HTTP API.',
    `Capabilities enabled for this run: ${policy.capabilities.join(', ')}. A capability that is off is refused with the switch that turns it on.`,
    `Allowed containers: ${policy.targets.join(', ') || 'none'}. exec, read_file and container_action reach only names matching that list; restart is the one named container the operator permitted.`,
    'info reads daemon facts, containers lists every container with image, state, mounts and compose labels, and discovery derives the host picture: which OS or appliance the daemon runs on (Unraid, MOS, Proxmox VE, OpenMediaVault, CasaOS, ZimaOS) with its evidence, compose stacks, containers that mount the daemon socket, and unmanaged containers.',
    `exec runs one fixed verb inside the named container - there is no command string: ${verbs}. read_file reads one absolute path out of that container (files up to 256 KiB, directories list).`,
    'Start with containers to find the name, then exec with network or processes, or read_file on the mounted configuration. Do not guess a container name; the list is authoritative.',
  ].join(' ');
}

export function createHostControlTool(
  policy: HostControlRunPolicy,
  { client }: { client?: HostControlClient } = {},
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

  return {
    name: 'host',
    label: 'Host',
    description: describe(policy),
    parameters: hostSchema as any,
    concurrency: 'exclusive',
    async execute(_toolCallId: string, rawParams: unknown) {
      const params = hostSchema.parse(rawParams);
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
