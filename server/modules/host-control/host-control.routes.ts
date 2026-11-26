import { Router, type Response } from 'express';

import { asyncHandler } from '@/shared/utils.js';

import {
  detectHost,
  dockerClient,
  DockerSocketError,
  isSshHost,
  isSshUser,
  parseSshHostKey,
  parseSshPort,
  parseSshPrivateKey,
  type HostControlClient,
  type HostProfile,
} from '../../gjc-engine.js';

import { clearSshPrivateKey, sshPrivateKeyPresent, writeSshPrivateKey } from './host-control.secrets.js';
import { generateSshKeyPair, scanSshHostKey } from './host-control.keys.js';
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

/**
 * The encrypted SSH key store. Injected like the settings and detection
 * stores: the real one reads the database, which a routing test has no reason
 * to open (and which aborts under some runtimes when it is not initialized).
 */
export type HostSecretsStore = {
  keyPresent(): boolean;
  write(key: string): void;
  clear(): void;
};

const defaultSecrets: HostSecretsStore = {
  keyPresent: sshPrivateKeyPresent,
  write: writeSshPrivateKey,
  clear: clearSshPrivateKey,
};

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
  secrets = defaultSecrets,
  env = process.env,
}: {
  client?: HostControlClient;
  store?: HostControlStore;
  profiles?: HostProfileStore;
  secrets?: HostSecretsStore;
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
    // A profile saved before discovery knew about platforms has no list. Status
    // must still answer for it: a stored record is not a reason to fail the read.
    const platform = saved?.profile.platforms?.[0];
    return {
      available,
      socketPath: dockerSocketPath(env),
      reachable: available ? await docker().ping() : false,
      enabled: settings.enabled,
      capabilities: Object.fromEntries(HOST_CAPABILITIES.map((name) => [name, settings[name]])),
      targets: settings.targets,
      // Never the key itself: only whether one is stored. A private key that
      // comes back out of a status read has left the operator's control.
      ssh: {
        host: settings.sshHost,
        port: settings.sshPort,
        user: settings.sshUser,
        hostKey: settings.sshHostKey,
        keyPresent: secrets.keyPresent(),
        writePreauthorized: settings.sshWritePreauthorized,
      },
      host: saved
        ? {
          os: saved.profile.runtime.operatingSystem,
          kernelVersion: saved.profile.runtime.kernelVersion,
          // The appliance or distro behind that OS string, when one is known:
          // "Debian GNU/Linux 12" alone would hide that this is a Proxmox guest.
          platform: platform ? { id: platform.id, label: platform.label } : null,
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
    // The SSH endpoint. The address is typed in - a default that guessed the
    // right host would be a guess that silently pointed somewhere else - and a
    // pasted `ssh-keyscan` line is normalized to the key it pins.
    if (body.sshHost !== undefined) {
      const value = typeof body.sshHost === 'string' ? body.sshHost.trim() : undefined;
      if (value === undefined || (value.length > 0 && !isSshHost(value))) {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'sshHost must be a hostname or a literal IP address.');
      }
      patch.sshHost = value;
    }
    if (body.sshPort !== undefined) {
      const port = parseSshPort(body.sshPort);
      if (port === undefined) {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'sshPort must be a whole number between 1 and 65535.');
      }
      patch.sshPort = port;
    }
    if (body.sshUser !== undefined) {
      if (!isSshUser(body.sshUser)) {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'sshUser must be a plain user name, for example root.');
      }
      patch.sshUser = body.sshUser;
    }
    if (body.sshHostKey !== undefined) {
      const value = typeof body.sshHostKey === 'string' ? body.sshHostKey.trim() : undefined;
      if (value === undefined) {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'sshHostKey must be a host public key line.');
      }
      if (value.length === 0) {
        patch.sshHostKey = '';
      } else {
        const key = parseSshHostKey(value);
        if (!key) {
          return refuse(
            response,
            400,
            'HOST_SETTINGS_INVALID',
            'sshHostKey must name the algorithm and the key, for example "ssh-ed25519 AAAAC3Nz…".',
          );
        }
        patch.sshHostKey = key;
      }
    }
    if (body.sshWritePreauthorized !== undefined) {
      if (typeof body.sshWritePreauthorized !== 'boolean') {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'sshWritePreauthorized must be true or false.');
      }
      patch.sshWritePreauthorized = body.sshWritePreauthorized;
    }
    // Write-only: an empty string forgets the key, and nothing ever reads it
    // back through this router.
    let keyChanged = false;
    if (body.sshPrivateKey !== undefined) {
      if (typeof body.sshPrivateKey !== 'string') {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'sshPrivateKey must be a private key in text form.');
      }
      if (body.sshPrivateKey.trim().length === 0) {
        secrets.clear();
      } else {
        const key = parseSshPrivateKey(body.sshPrivateKey);
        if (!key) {
          return refuse(
            response,
            400,
            'HOST_SETTINGS_INVALID',
            'sshPrivateKey must be an unencrypted OpenSSH or PEM private key, up to 16 KiB.',
          );
        }
        secrets.write(key);
      }
      keyChanged = true;
    }
    if (Object.keys(patch).length === 0 && !keyChanged) {
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

  /**
   * A fresh client key pair for this app to sign in with.
   *
   * Separate from the destination's host key on purpose: this is the app's own
   * identity, replacing it invalidates every machine that trusted the previous
   * public key. Nothing here touches the pinned host key, and nothing scans the
   * destination - an address change must not silently rotate the client key.
   */
  router.post('/ssh/keys', asyncHandler(async (_request, response) => {
    if (!hostControlAvailable(env)) {
      return refuse(response, 409, 'HOST_CONTROL_DISABLED', 'Host control is not enabled for this deployment.');
    }
    let generated;
    try {
      generated = await generateSshKeyPair();
    } catch (error) {
      return refuse(
        response,
        503,
        'SSH_KEYGEN_UNAVAILABLE',
        error instanceof Error ? error.message : 'A key pair could not be generated.',
      );
    }
    secrets.write(generated.privateKey);
    return response.json({ publicKey: generated.publicKey });
  }));

  /**
   * The destination's host key, read the only way it can be read: from the
   * destination. A host key generated here would belong to this process and
   * could never match the machine being reached.
   *
   * This never regenerates the client key pair. Adding a second machine pins
   * its host key while every machine already trusting this app's public key
   * keeps working. An existing pin is never silently replaced: if the scan
   * disagrees, the pin is kept and the caller is told, so a changed host is a
   * decision rather than a race with a button.
   */
  router.post('/ssh/host-key', asyncHandler(async (request, response) => {
    if (!hostControlAvailable(env)) {
      return refuse(response, 409, 'HOST_CONTROL_DISABLED', 'Host control is not enabled for this deployment.');
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const patch: Partial<HostControlSettings> = {};
    if (body.host !== undefined) {
      const value = typeof body.host === 'string' ? body.host.trim() : undefined;
      if (value === undefined || (value.length > 0 && !isSshHost(value))) {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'host must be a hostname or a literal IP address.');
      }
      patch.sshHost = value;
    }
    if (body.port !== undefined) {
      const port = parseSshPort(body.port);
      if (port === undefined) {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'port must be a whole number between 1 and 65535.');
      }
      patch.sshPort = port;
    }
    if (body.user !== undefined) {
      if (!isSshUser(body.user)) {
        return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'user must be a plain user name, for example root.');
      }
      patch.sshUser = body.user;
    }
    const settings = Object.keys(patch).length > 0 ? store.write(patch) : store.read();
    if (!settings.sshHost) {
      return refuse(response, 400, 'HOST_SETTINGS_INVALID', 'Set the SSH address before reading its host key.');
    }
    let scannedHostKey: string;
    try {
      scannedHostKey = await scanSshHostKey(settings.sshHost, settings.sshPort);
    } catch (error) {
      return refuse(
        response,
        503,
        'SSH_HOST_KEY_UNAVAILABLE',
        error instanceof Error ? error.message : 'The host key could not be read.',
      );
    }
    const pinned = settings.sshHostKey;
    if (!pinned) {
      store.write({ sshHostKey: scannedHostKey });
      return response.json({ hostKey: scannedHostKey, scannedHostKey });
    }
    if (pinned !== scannedHostKey) {
      return response.json({
        hostKey: pinned,
        scannedHostKey,
        hostKeyError: 'The host presented a different key than the pinned one; the pinned key was kept.',
      });
    }
    return response.json({ hostKey: pinned, scannedHostKey });
  }));

  return router;
}

export default createHostControlRouter();
