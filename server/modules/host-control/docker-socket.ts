import { request } from 'node:http';

import { dockerSocketPath } from './host-control.settings.js';

/**
 * The smallest useful Docker client: three fixed endpoints over the daemon's
 * unix socket, and a container name that must look like one. There is no
 * generic "call this path" function, so nothing above this file can reach an
 * endpoint that is not listed here.
 */

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

export type HostContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
};

export type HostInfo = {
  serverVersion: string;
  operatingSystem: string;
  kernelVersion: string;
  ncpu: number;
  memTotal: number;
  containers: number;
  containersRunning: number;
  containersStopped: number;
  images: number;
};

export type HostControlClient = {
  /** True when the daemon answers its health endpoint. */
  ping(): Promise<boolean>;
  info(): Promise<HostInfo>;
  list(): Promise<HostContainer[]>;
  restart(name: string): Promise<void>;
};

export type DockerSocketErrorCode = 'DOCKER_UNAVAILABLE' | 'DOCKER_TIMEOUT' | 'DOCKER_HTTP' | 'INVALID_CONTAINER';

export class DockerSocketError extends Error {
  readonly code: DockerSocketErrorCode;

  constructor(code: DockerSocketErrorCode, message: string) {
    super(message);
    this.name = 'DockerSocketError';
    this.code = code;
  }
}

export function isContainerName(value: unknown): value is string {
  return typeof value === 'string' && CONTAINER_NAME.test(value);
}

function socketRequest(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method, headers: { Host: 'docker' }, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new DockerSocketError('DOCKER_TIMEOUT', 'The Docker daemon did not answer in time.'));
    });
    req.on('error', () => {
      reject(new DockerSocketError('DOCKER_UNAVAILABLE', 'The Docker socket is not reachable.'));
    });
    req.end();
  });
}

function parseCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInfo(body: string): HostInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon returned something that is not JSON.');
  }
  const record = (parsed ?? {}) as Record<string, unknown>;
  return {
    serverVersion: String(record.ServerVersion ?? ''),
    operatingSystem: String(record.OperatingSystem ?? ''),
    kernelVersion: String(record.KernelVersion ?? ''),
    ncpu: parseCount(record.NCPU),
    memTotal: parseCount(record.MemTotal),
    containers: parseCount(record.Containers),
    containersRunning: parseCount(record.ContainersRunning),
    containersStopped: parseCount(record.ContainersStopped),
    images: parseCount(record.Images),
  };
}

function parseContainers(body: string): HostContainer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon returned something that is not JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon returned an unexpected container list.');
  }
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    const names = Array.isArray(record.Names) ? record.Names : [];
    return {
      id: String(record.Id ?? '').slice(0, 12),
      name: String(names[0] ?? '').replace(/^\//u, ''),
      image: String(record.Image ?? ''),
      state: String(record.State ?? ''),
      status: String(record.Status ?? ''),
    };
  }).filter((container) => container.name);
}

export function dockerClient({
  socketPath = dockerSocketPath(),
  timeoutMs = 5000,
}: { socketPath?: string; timeoutMs?: number } = {}): HostControlClient {
  return {
    async ping() {
      try {
        const { status, body } = await socketRequest(socketPath, 'GET', '/_ping', timeoutMs);
        return status === 200 && body.trim() === 'OK';
      } catch {
        return false;
      }
    },

    async list() {
      const { status, body } = await socketRequest(socketPath, 'GET', '/containers/json?all=1', timeoutMs);
      if (status !== 200) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${status}.`);
      return parseContainers(body);
    },

    async info() {
      const { status, body } = await socketRequest(socketPath, 'GET', '/info', timeoutMs);
      if (status !== 200) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${status}.`);
      return parseInfo(body);
    },

    async restart(name) {
      if (!isContainerName(name)) {
        throw new DockerSocketError('INVALID_CONTAINER', `${JSON.stringify(name)} is not a container name.`);
      }
      const { status } = await socketRequest(socketPath, 'POST', `/containers/${encodeURIComponent(name)}/restart`, timeoutMs);
      // 304 means "already restarting", which is still the state the caller asked for.
      if (status !== 204 && status !== 304) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${status}.`);
    },
  };
}
