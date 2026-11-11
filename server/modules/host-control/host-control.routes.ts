import { Router, type Response } from 'express';

import { asyncHandler, routeParam } from '@/shared/utils.js';

import { dockerClient, DockerSocketError, isArchivePath, isContainerAction, isContainerName, type HostControlClient } from './docker-socket.js';
import {
  allowsHostCapability,
  dockerSocketPath,
  hostControlAvailable,
  HOST_CAPABILITIES,
  isTargetPattern,
  matchesHostTarget,
  parseTargets,
  readHostControlSettings,
  writeHostControlSettings,
  type HostCapability,
  type HostControlSettings,
} from './host-control.settings.js';
import { describeExecVerbs, EXEC_VERBS, findExecVerb } from './exec-verbs.js';
import { detectHost, type HostProfile } from './host-discovery.js';
import { readSavedHostProfile, saveHostProfile, type SavedHostProfile } from './host-profile.store.js';

export type HostControlStore = {
  read(): HostControlSettings;
  write(patch: Partial<HostControlSettings>): HostControlSettings;
};

const defaultStore: HostControlStore = { read: readHostControlSettings, write: writeHostControlSettings };

export type HostProfileStore = {
  read(): SavedHostProfile | null;
  write(profile: HostProfile): SavedHostProfile;
};

const defaultProfiles: HostProfileStore = { read: readSavedHostProfile, write: saveHostProfile };

/** Capabilities that also have to be scoped to a named container. */
const SCOPED: ReadonlySet<HostCapability> = new Set<HostCapability>(['docker', 'shell', 'files']);

function refuse(response: Response, status: number, error: string, detail: string): Response {
  return response.status(status).json({ error, detail });
}

function dockerFailure(response: Response, error: unknown): Response {
  if (error instanceof DockerSocketError) {
    if (error.code === 'INVALID_CONTAINER' || error.code === 'INVALID_PATH') return refuse(response, 400, error.code, error.message);
    if (error.code === 'DOCKER_NOT_FOUND') return refuse(response, 404, error.code, error.message);
    // The daemon understood the request and refused it, which is not an outage.
    if (error.code === 'DOCKER_CONFLICT') return refuse(response, 409, error.code, error.message);
    return refuse(response, 503, error.code, error.message);
  }
  return refuse(response, 503, 'DOCKER_UNAVAILABLE', 'The Docker daemon could not be reached.');
}

/**
 * `/api/host` - the host-facing half of Automation.
 *
 * The env gate is checked on every request rather than at boot, so a process
 * that was started without it can never be talked into host access, and one
 * that loses it stops answering immediately. Capabilities are checked
 * independently: reading facts and restarting a container are different
 * permissions, and neither implies the other. The reaching capabilities are
 * additionally bounded by the operator's container list.
 */
export function createHostControlRouter({
  client,
  store = defaultStore,
  profiles = defaultProfiles,
  env = process.env,
}: {
  client?: HostControlClient;
  store?: HostControlStore;
  profiles?: HostProfileStore;
  env?: NodeJS.ProcessEnv;
} = {}): Router {
  const router = Router();
  const docker = (): HostControlClient => client ?? dockerClient({ socketPath: dockerSocketPath(env) });

  const snapshot = async () => {
    const available = hostControlAvailable(env);
    const settings = store.read();
    const capability = (name: HostCapability) => settings[name];
    // The last saved detection rides along with the cheap status read, so a
    // caller learns which machine this is without triggering another one - and
    // only while detection is switched on, since the answer names the host.
    const saved = allowsHostCapability(settings, 'discovery') ? profiles.read() : null;
    return {
      available,
      socketPath: dockerSocketPath(env),
      reachable: available ? await docker().ping() : false,
      enabled: settings.enabled,
      capabilities: Object.fromEntries(HOST_CAPABILITIES.map((name) => [name, capability(name)])),
      targets: settings.targets,
      host: saved
        ? {
          os: saved.profile.runtime.operatingSystem,
          kernelVersion: saved.profile.runtime.kernelVersion,
          detectedAt: saved.detectedAt,
        }
        : null,
    };
  };

  /** `null` when the request may proceed, otherwise the response is already sent. */
  const guard = (response: Response, capability: HostCapability, target?: string): boolean => {
    if (!hostControlAvailable(env)) {
      refuse(response, 409, 'HOST_CONTROL_DISABLED', 'Host control is not enabled for this deployment.');
      return false;
    }
    const settings = store.read();
    if (!allowsHostCapability(settings, capability)) {
      refuse(response, 403, 'HOST_CAPABILITY_DENIED', `The ${capability} capability is switched off in Settings.`);
      return false;
    }
    if (target !== undefined && SCOPED.has(capability) && !matchesHostTarget(settings.targets, target)) {
      refuse(
        response,
        403,
        'HOST_TARGET_DENIED',
        `The ${capability} capability is on, but ${JSON.stringify(target)} is not on the Allowed containers list in Settings.`,
      );
      return false;
    }
    return true;
  };

  router.get('/status', asyncHandler(async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(await snapshot());
  }));

  router.put('/settings', asyncHandler(async (request, response) => {
    if (!hostControlAvailable(env)) {
      return refuse(response, 409, 'HOST_CONTROL_DISABLED', 'Host control is not enabled for this deployment.');
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Partial<HostControlSettings> = {};
    for (const key of ['enabled', ...HOST_CAPABILITIES] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', `${key} must be true or false.`);
      }
      patch[key] = body[key] as boolean;
    }
    if (body.targets !== undefined) {
      // Trim first, then validate: a pasted list arrives with spaces after the
      // commas, and that is not a reason to refuse the whole update.
      const targets = Array.isArray(body.targets)
        ? body.targets.map((value) => (typeof value === 'string' ? value.trim() : value))
        : body.targets;
      if (!Array.isArray(targets) || !targets.every(isTargetPattern)) {
        return refuse(
          response,
          400,
          'HOST_SETTINGS_INVALID',
          'targets must be a list of container-name globs, for example ["mos-*", "immich_*"].',
        );
      }
      patch.targets = parseTargets(targets);
    }
    if (Object.keys(patch).length === 0) {
      return refuse(response, 400, 'HOST_SETTINGS_EMPTY', 'Nothing to update.');
    }
    store.write(patch);
    return response.json(await snapshot());
  }));

  router.get('/info', asyncHandler(async (_request, response) => {
    if (!guard(response, 'facts')) return;
    try {
      response.set('Cache-Control', 'no-store');
      response.json({ info: await docker().info() });
    } catch (error) {
      dockerFailure(response, error);
    }
  }));

  router.get('/containers', asyncHandler(async (_request, response) => {
    if (!guard(response, 'containers')) return;
    try {
      response.set('Cache-Control', 'no-store');
      response.json({ containers: await docker().list() });
    } catch (error) {
      dockerFailure(response, error);
    }
  }));

  /**
   * What is actually running this host, and who else is managing it. Reads the
   * same two endpoints `facts` and `containers` do; the value is the derived
   * picture, so an agent knows whether it is talking to plain docker, a compose
   * stack, Portainer, or an appliance's own manager before it touches anything.
   */
  router.get('/discovery', asyncHandler(async (_request, response) => {
    if (!guard(response, 'discovery')) return;
    try {
      response.set('Cache-Control', 'no-store');
      const [info, containers] = await Promise.all([docker().info(), docker().list()]);
      const profile = detectHost({ info, containers, socketPath: dockerSocketPath(env) });
      // Kept, not just returned: this is the only place the picture is built,
      // so this is the only place it can be remembered for later callers.
      const saved = profiles.write(profile);
      response.json({ profile, detectedAt: saved.detectedAt });
    } catch (error) {
      dockerFailure(response, error);
    }
  }));

  // Deliberately POST: only an explicit action restarts something, and the
  // name has to be a plain container name before it reaches the socket.
  router.post('/containers/:name/restart', asyncHandler(async (request, response) => {
    if (!guard(response, 'restart')) return;
    const name = routeParam(request.params.name);
    if (!isContainerName(name)) {
      return refuse(response, 400, 'INVALID_CONTAINER', 'That is not a container name.');
    }
    try {
      await docker().restart(name);
      return response.json({ restarted: true, name });
    } catch (error) {
      return dockerFailure(response, error);
    }
  }));

  /** start/stop/restart/pause/unpause, one container, and only one on the list. */
  router.post('/containers/:name/action', asyncHandler(async (request, response) => {
    const name = routeParam(request.params.name);
    if (!isContainerName(name)) {
      return refuse(response, 400, 'INVALID_CONTAINER', 'That is not a container name.');
    }
    const action = (request.body ?? {}).action;
    if (!isContainerAction(action)) {
      return refuse(response, 400, 'INVALID_ACTION', 'action must be one of start, stop, restart, pause, unpause.');
    }
    if (!guard(response, 'docker', name)) return;
    try {
      await docker().action(name, action);
      return response.json({ name, action, done: true });
    } catch (error) {
      return dockerFailure(response, error);
    }
  }));

  /** The allow-list itself, so a caller can see what it may ask for. */
  router.get('/verbs', asyncHandler(async (_request, response) => {
    if (!guard(response, 'shell')) return;
    response.set('Cache-Control', 'no-store');
    response.json({ verbs: describeExecVerbs(), note: 'Each verb is one fixed command; there is no way to pass a command string.' });
  }));

  /** A named verb inside a named container: the scoped shell. */
  router.post('/exec', asyncHandler(async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const container = body.container;
    if (!isContainerName(container)) {
      return refuse(response, 400, 'INVALID_CONTAINER', 'container must be a container name.');
    }
    const verb = findExecVerb(body.verb);
    if (!verb) {
      return refuse(response, 400, 'UNKNOWN_VERB', `Unknown verb. Known verbs: ${EXEC_VERBS.map((entry) => entry.id).join(', ')}.`);
    }
    if (!guard(response, 'shell', container)) return;
    try {
      const result = await docker().exec(container, verb.command);
      return response.json({ container, verb: verb.id, command: verb.command.join(' '), ...result });
    } catch (error) {
      return dockerFailure(response, error);
    }
  }));

  /** Read one file, or list one directory, out of a container filesystem. */
  router.get('/files', asyncHandler(async (request, response) => {
    const container = request.query.container;
    const path = request.query.path;
    if (!isContainerName(container)) {
      return refuse(response, 400, 'INVALID_CONTAINER', 'container must be a container name.');
    }
    if (!isArchivePath(path)) {
      return refuse(response, 400, 'INVALID_PATH', 'path must be an absolute path with no ".." segment.');
    }
    if (!guard(response, 'files', container)) return;
    try {
      const archive = await docker().archive(container, path);
      response.set('Cache-Control', 'no-store');
      if (archive.kind === 'too-large') {
        return refuse(response, 413, 'FILE_TOO_LARGE', `${JSON.stringify(archive.name)} is ${archive.size} bytes; the read limit is 256 KiB.`);
      }
      if (archive.kind === 'dir') {
        return response.json({ container, path, entries: archive.entries, truncated: archive.truncated });
      }
      return response.json({
        container,
        path,
        name: archive.name,
        size: archive.size,
        encoding: 'utf8',
        content: archive.content.toString('utf8'),
        truncated: archive.truncated,
      });
    } catch (error) {
      return dockerFailure(response, error);
    }
  }));

  return router;
}

export default createHostControlRouter();
