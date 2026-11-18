import { Router, type Response } from 'express';

import { asyncHandler } from '@/shared/utils.js';

import {
  detectHost,
  dockerClient,
  DockerSocketError,
  type HostControlClient,
  type HostProfile,
} from '../../gjc-engine.js';

import {
  allowsHostCapability,
  dockerSocketPath,
  hostControlAvailable,
  HOST_CAPABILITIES,
  isTargetPattern,
  parseTargets,
  readHostControlSettings,
  writeHostControlSettings,
  type HostCapability,
  type HostControlSettings,
} from './host-control.settings.js';
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
 * `/api/host` - what Settings needs to show, and nothing more.
 *
 * Status, the switches, and discovery: that is the whole HTTP surface. The
 * agent does not come through here - it has a native `host` tool that talks to
 * the daemon socket directly - so there is no HTTP endpoint for arbitrary
 * container reads, restarts, execs or file reads. Keeping those routes after
 * the tool existed would have left a second, independently authenticated path
 * to the Docker daemon that no caller used, which is surface without a reason.
 *
 * The env gate is checked on every request rather than at boot, so a process
 * started without it can never be talked into host access, and one that loses
 * it stops answering immediately.
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

  /** The one place the picture is built, so the one place it is remembered. */
  const detect = async (): Promise<SavedHostProfile> => {
    const [info, containers] = await Promise.all([docker().info(), docker().list()]);
    return profiles.write(detectHost({ info, containers, socketPath: dockerSocketPath(env) }));
  };

  const snapshot = async () => {
    const available = hostControlAvailable(env);
    const settings = store.read();
    // The last saved detection rides along with the cheap status read, so a
    // caller learns which machine this is without triggering another one - and
    // only while detection is switched on, since the answer names the host.
    const saved = allowsHostCapability(settings, 'discovery') ? profiles.read() : null;
    return {
      available,
      socketPath: dockerSocketPath(env),
      reachable: available ? await docker().ping() : false,
      enabled: settings.enabled,
      capabilities: Object.fromEntries(HOST_CAPABILITIES.map((name) => [name, settings[name]])),
      targets: settings.targets,
      host: saved
        ? {
          os: saved.profile.runtime.operatingSystem,
          kernelVersion: saved.profile.runtime.kernelVersion,
          // The appliance or distro behind that OS string, when one is known:
          // "Debian GNU/Linux 12" alone would hide that this is a Proxmox guest.
          platform: saved.profile.platforms[0]
            ? { id: saved.profile.platforms[0].id, label: saved.profile.platforms[0].label }
            : null,
          detectedAt: saved.detectedAt,
        }
        : null,
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
    const current = store.read();
    const next = store.write(patch);
    // Switching the host reads on is the operator asking to see the machine, so
    // answer in the same response instead of making them press Detect too. Only
    // on the transition: further saves reuse the stored picture, and nothing
    // runs at the start of a session or a turn - detection costs a daemon read,
    // not model tokens. A daemon that cannot be reached must not fail the switch.
    if (next.enabled && next.discovery && !(current.enabled && current.discovery)) {
      await detect().catch(() => null);
    }
    return response.json(await snapshot());
  }));

  /**
   * What is actually running this host, and who else is managing it. Reads the
   * two endpoints `facts` and `containers` do; the value is the derived
   * picture, so the next session knows whether it is talking to plain docker,
   * a compose stack, Portainer, or an appliance's own manager.
   */
  router.get('/discovery', asyncHandler(async (_request, response) => {
    if (!guard(response, 'discovery')) return;
    response.set('Cache-Control', 'no-store');
    try {
      // Kept, not just returned: later status reads report it without another
      // detection, and that is the only way the answer survives a restart.
      const saved = await detect();
      response.json({ profile: saved.profile, detectedAt: saved.detectedAt });
    } catch (error) {
      dockerFailure(response, error);
    }
  }));

  return router;
}

export default createHostControlRouter();
