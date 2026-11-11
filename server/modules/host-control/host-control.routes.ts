import { Router, type Response } from 'express';

import { asyncHandler, routeParam } from '@/shared/utils.js';

import { dockerClient, DockerSocketError, isContainerName, type HostControlClient } from './docker-socket.js';
import {
  allowsHostCapability,
  dockerSocketPath,
  hostControlAvailable,
  readHostControlSettings,
  writeHostControlSettings,
  type HostCapability,
  type HostControlSettings,
} from './host-control.settings.js';

export type HostControlStore = {
  read(): HostControlSettings;
  write(patch: Partial<HostControlSettings>): HostControlSettings;
};

const defaultStore: HostControlStore = { read: readHostControlSettings, write: writeHostControlSettings };

const CAPABILITIES: HostCapability[] = ['facts', 'containers', 'restart'];

function refuse(response: Response, status: number, error: string, detail: string): Response {
  return response.status(status).json({ error, detail });
}

function dockerFailure(response: Response, error: unknown): Response {
  if (error instanceof DockerSocketError) {
    if (error.code === 'INVALID_CONTAINER') return refuse(response, 400, error.code, error.message);
    // A name the daemon does not know is the caller's mistake, not an outage.
    if (error.code === 'DOCKER_NOT_FOUND') return refuse(response, 404, error.code, error.message);
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
 * independently: listing containers and restarting one are different
 * permissions, and neither implies the other.
 */
export function createHostControlRouter({
  client,
  store = defaultStore,
  env = process.env,
}: { client?: HostControlClient; store?: HostControlStore; env?: NodeJS.ProcessEnv } = {}): Router {
  const router = Router();
  const docker = (): HostControlClient => client ?? dockerClient({ socketPath: dockerSocketPath(env) });

  const snapshot = async () => {
    const available = hostControlAvailable(env);
    const settings = store.read();
    return {
      available,
      socketPath: dockerSocketPath(env),
      reachable: available ? await docker().ping() : false,
      enabled: settings.enabled,
      capabilities: {
        facts: settings.facts,
        containers: settings.containers,
        restart: settings.restart,
      },
    };
  };

  /** `null` when the request may proceed, otherwise the response is already sent. */
  const guard = (response: Response, capability: HostCapability): boolean => {
    if (!hostControlAvailable(env)) {
      refuse(response, 409, 'HOST_CONTROL_DISABLED', 'Host control is not enabled for this deployment.');
      return false;
    }
    if (!allowsHostCapability(store.read(), capability)) {
      refuse(response, 403, 'HOST_CAPABILITY_DENIED', `The ${capability} capability is switched off in Settings.`);
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
    for (const key of ['enabled', ...CAPABILITIES] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', `${key} must be true or false.`);
      }
      patch[key] = body[key] as boolean;
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

  return router;
}

export default createHostControlRouter();
