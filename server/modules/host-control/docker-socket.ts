import { request } from 'node:http';

import { dockerSocketPath } from './host-control.settings.js';

/**
 * The smallest useful Docker client: a named method per endpoint, never a
 * generic "call this path". Nothing above this file can reach an endpoint that
 * is not written here, which is what keeps the capability switches meaningful.
 */

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

const DEFAULT_MAX_BYTES = 256 * 1024;
const ARCHIVE_MAX_BYTES = 4 * 1024 * 1024;

export type HostMount = { type: string; source: string; destination: string };

export type HostContainer = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
  mounts: HostMount[];
};

export type HostInfo = {
  serverVersion: string;
  operatingSystem: string;
  kernelVersion: string;
  hostName: string;
  driver: string;
  swarm: string;
  ncpu: number;
  memTotal: number;
  containers: number;
  containersRunning: number;
  containersStopped: number;
  images: number;
};

/** The only state changes this client can ask a container for. */
export const CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause'] as const;
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

export function isContainerAction(value: unknown): value is ContainerAction {
  return typeof value === 'string' && (CONTAINER_ACTIONS as readonly string[]).includes(value);
}

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type HostArchiveEntry = { name: string; size: number; type: 'file' | 'dir' | 'other' };

export type HostArchive =
  | { kind: 'dir'; entries: HostArchiveEntry[]; truncated: boolean }
  | { kind: 'file'; name: string; size: number; content: Buffer; truncated: boolean }
  | { kind: 'too-large'; name: string; size: number };

export type HostControlClient = {
  /** True when the daemon answers its health endpoint. */
  ping(): Promise<boolean>;
  info(): Promise<HostInfo>;
  list(): Promise<HostContainer[]>;
  restart(name: string): Promise<void>;
  action(name: string, action: ContainerAction): Promise<void>;
  exec(name: string, command: readonly string[], options?: { maxBytes?: number; timeoutMs?: number }): Promise<ExecResult>;
  archive(name: string, path: string, options?: { maxFileBytes?: number }): Promise<HostArchive>;
};

export type DockerSocketErrorCode =
  | 'DOCKER_CONFLICT'
  | 'DOCKER_HTTP'
  | 'DOCKER_NOT_FOUND'
  | 'DOCKER_TIMEOUT'
  | 'DOCKER_UNAVAILABLE'
  | 'INVALID_CONTAINER'
  | 'INVALID_PATH';

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

/**
 * A path is only allowed to name something inside a container filesystem: the
 * daemon resolves `..` itself, so a traversal must be refused before it gets
 * there and `..` inside a name (`a..b`) must keep working.
 */
export function isArchivePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  if (!value.startsWith('/') || value.includes('\0')) return false;
  return !value.split('/').some((segment) => segment === '..');
}

type SocketRequest = {
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

type SocketResponse = { status: number; body: Buffer; truncated: boolean };

function socketRequest(
  socketPath: string,
  { method, path, body, timeoutMs = 5000, maxBytes = DEFAULT_MAX_BYTES }: SocketRequest,
): Promise<SocketResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = { Host: 'docker' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = request({ socketPath, path, method, headers, timeout: timeoutMs }, (response) => {
      const chunks: Buffer[] = [];
      let kept = 0;
      let truncated = false;
      response.on('data', (chunk: Buffer) => {
        // Keep draining past the cap so the daemon finishes the response, but
        // stop holding the bytes: a runaway command must not become a memory
        // exhaustion in the app that asked for it.
        if (kept >= maxBytes) {
          truncated = true;
          return;
        }
        const room = maxBytes - kept;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        chunks.push(slice);
        kept += slice.length;
        if (slice.length < chunk.length) truncated = true;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), truncated }));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new DockerSocketError('DOCKER_TIMEOUT', 'The Docker daemon did not answer in time.'));
    });
    req.on('error', () => {
      reject(new DockerSocketError('DOCKER_UNAVAILABLE', 'The Docker socket is not reachable.'));
    });
    req.end(body);
  });
}

function parseJson(body: Buffer, what: string): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon returned ${what} that is not JSON.`);
  }
}

/**
 * Docker answers 404 both for a container it does not know and for an endpoint it
 * does not serve, and only the first one is the caller's mistake. The message is
 * the only thing that tells them apart. A 404 with no message at all still reads
 * as a missing container, because that is the likelier cause on this endpoint.
 */
function isMissingContainer(body: Buffer): boolean {
  const text = body.toString('utf8');
  if (!text.trim()) return true;
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message !== 'string') return true;
    return /no such container/iu.test(parsed.message);
  } catch {
    return true;
  }
}

function parseCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInfo(body: Buffer): HostInfo {
  const record = (parseJson(body, 'something') ?? {}) as Record<string, unknown>;
  const swarm = (record.Swarm ?? {}) as Record<string, unknown>;
  return {
    serverVersion: String(record.ServerVersion ?? ''),
    operatingSystem: String(record.OperatingSystem ?? ''),
    kernelVersion: String(record.KernelVersion ?? ''),
    hostName: String(record.Name ?? ''),
    driver: String(record.Driver ?? ''),
    swarm: String(swarm.LocalNodeState ?? ''),
    ncpu: parseCount(record.NCPU),
    memTotal: parseCount(record.MemTotal),
    containers: parseCount(record.Containers),
    containersRunning: parseCount(record.ContainersRunning),
    containersStopped: parseCount(record.ContainersStopped),
    images: parseCount(record.Images),
  };
}

function parseMounts(value: unknown): HostMount[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      type: String(record.Type ?? ''),
      source: String(record.Source ?? ''),
      destination: String(record.Destination ?? ''),
    };
  });
}

function parseContainers(body: Buffer): HostContainer[] {
  const parsed = parseJson(body, 'a container list');
  if (!Array.isArray(parsed)) {
    throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon returned an unexpected container list.');
  }
  return parsed.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const names = Array.isArray(record.Names) ? record.Names : [];
    const labels = (record.Labels ?? {}) as Record<string, unknown>;
    return {
      id: String(record.Id ?? '').slice(0, 12),
      name: String(names[0] ?? '').replace(/^\//u, ''),
      image: String(record.Image ?? ''),
      state: String(record.State ?? ''),
      status: String(record.Status ?? ''),
      labels: Object.fromEntries(Object.entries(labels).map(([key, value]) => [key, String(value)])),
      mounts: parseMounts(record.Mounts),
    };
  }).filter((container) => container.name);
}

/**
 * `exec start` writes a multiplexed stream: an 8-byte header per chunk (stream
 * id, three zero bytes, big-endian length) and then that many bytes. A proxy or
 * an old daemon can answer with a plain body instead, so a body that is not
 * framed is read as stdout rather than dropped.
 */
export function parseExecFrames(body: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= body.length) {
    const stream = body[offset];
    const zeroed = body[offset + 1] === 0 && body[offset + 2] === 0 && body[offset + 3] === 0;
    if (!zeroed || (stream !== 1 && stream !== 2)) {
      return { stdout: body.toString('utf8'), stderr: '' };
    }
    const size = body.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, body.length);
    (stream === 1 ? out : err).push(body.subarray(start, end));
    offset = start + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

type TarEntry = { name: string; size: number; type: 'file' | 'dir' | 'other'; dataStart: number };

/**
 * Enough tar to read what `GET /containers/{name}/archive` returns: 512-byte
 * headers, octal sizes, and the GNU long-name and PAX headers Docker emits for
 * long paths. Nothing is extracted, so links and permissions are irrelevant.
 */
export function listTarEntries(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawSize = header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(rawSize || '0', 8);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const headerName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const dataStart = offset + 512;
    const dataEnd = Math.min(dataStart + (Number.isFinite(size) ? size : 0), archive.length);
    const padded = dataStart + Math.ceil((Number.isFinite(size) ? size : 0) / 512) * 512;
    if (typeflag === 'L') {
      pendingName = archive.subarray(dataStart, dataEnd).toString('utf8').replace(/\0.*$/u, '').replace(/\n$/u, '');
      offset = padded;
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      offset = padded;
      continue;
    }
    const name = (pendingName ?? headerName).replace(/\/$/u, '');
    pendingName = undefined;
    if (name) {
      entries.push({
        name,
        size: Number.isFinite(size) ? size : 0,
        type: typeflag === '5' ? 'dir' : typeflag === '0' || typeflag === '\0' || typeflag === '' ? 'file' : 'other',
        dataStart,
      });
    }
    offset = padded;
  }
  return entries;
}

function commandIsPlain(command: readonly string[]): boolean {
  return Array.isArray(command)
    && command.length > 0
    && command.length <= 8
    && command.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 512 && !part.includes('\0'));
}

export function dockerClient({
  socketPath = dockerSocketPath(),
  timeoutMs = 5000,
  // A restart is not a read: the daemon stops the container, waits out its
  // stop grace period and starts it again, which routinely outlasts the
  // deadline that suits a JSON listing. Reporting a timeout for a restart
  // that is in fact happening would be worse than waiting.
  restartTimeoutMs = 60_000,
}: { socketPath?: string; timeoutMs?: number; restartTimeoutMs?: number } = {}): HostControlClient {
  const requireName = (name: unknown): string => {
    if (!isContainerName(name)) {
      throw new DockerSocketError('INVALID_CONTAINER', `${JSON.stringify(name)} is not a container name.`);
    }
    return name;
  };

  return {
    async ping() {
      try {
        const { status, body } = await socketRequest(socketPath, { method: 'GET', path: '/_ping', timeoutMs });
        return status === 200 && body.toString('utf8').trim() === 'OK';
      } catch {
        return false;
      }
    },

    async list() {
      const { status, body } = await socketRequest(socketPath, { method: 'GET', path: '/containers/json?all=1', timeoutMs });
      if (status !== 200) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${status}.`);
      return parseContainers(body);
    },

    async info() {
      const { status, body } = await socketRequest(socketPath, { method: 'GET', path: '/info', timeoutMs });
      if (status !== 200) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${status}.`);
      return parseInfo(body);
    },

    async action(name, action) {
      requireName(name);
      if (!isContainerAction(action)) {
        throw new DockerSocketError('DOCKER_HTTP', `${JSON.stringify(action)} is not a container action.`);
      }
      const deadline = action === 'stop' || action === 'restart' ? restartTimeoutMs : timeoutMs;
      const { status, body } = await socketRequest(socketPath, {
        method: 'POST',
        path: `/containers/${encodeURIComponent(name)}/${action}`,
        timeoutMs: deadline,
      });
      if (status === 404 && isMissingContainer(body)) {
        throw new DockerSocketError('DOCKER_NOT_FOUND', `There is no container called ${JSON.stringify(name)}.`);
      }
      if (status === 409) {
        throw new DockerSocketError('DOCKER_CONFLICT', `The Docker daemon refused to ${action} ${JSON.stringify(name)} right now.`);
      }
      // 304 means "already in that state", which is still the state the caller asked for.
      if (status !== 204 && status !== 304) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${status}.`);
    },

    async restart(name) {
      await this.action(requireName(name), 'restart');
    },

    async exec(name, command, { maxBytes = 64 * 1024, timeoutMs: execTimeoutMs = 20_000 } = {}) {
      requireName(name);
      if (!commandIsPlain(command)) {
        throw new DockerSocketError('DOCKER_HTTP', 'A command must be a short list of plain arguments.');
      }
      const created = await socketRequest(socketPath, {
        method: 'POST',
        path: `/containers/${encodeURIComponent(name)}/exec`,
        body: JSON.stringify({ AttachStdout: true, AttachStderr: true, Tty: false, Cmd: [...command] }),
        timeoutMs,
      });
      if (created.status === 404) {
        throw new DockerSocketError('DOCKER_NOT_FOUND', `There is no container called ${JSON.stringify(name)}.`);
      }
      if (created.status === 409) {
        throw new DockerSocketError('DOCKER_CONFLICT', `${JSON.stringify(name)} is not running, so nothing can run inside it.`);
      }
      if (created.status !== 201) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${created.status}.`);
      const execId = String(((parseJson(created.body, 'an exec response') ?? {}) as Record<string, unknown>).Id ?? '');
      if (!execId) throw new DockerSocketError('DOCKER_HTTP', 'The Docker daemon did not return an exec id.');

      const started = await socketRequest(socketPath, {
        method: 'POST',
        path: `/exec/${encodeURIComponent(execId)}/start`,
        body: JSON.stringify({ Detach: false, Tty: false }),
        timeoutMs: execTimeoutMs,
        maxBytes,
      });
      if (started.status === 409) throw new DockerSocketError('DOCKER_CONFLICT', 'That exec is already running.');
      if (started.status !== 200) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${started.status}.`);
      const { stdout, stderr } = parseExecFrames(started.body);

      // `exec start` returns when the command's output ends, so the exit code is
      // usually already there; the short loop covers a stream that ends first.
      let exitCode = -1;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const inspected = await socketRequest(socketPath, { method: 'GET', path: `/exec/${encodeURIComponent(execId)}/json`, timeoutMs });
        if (inspected.status !== 200) break;
        const record = (parseJson(inspected.body, 'an exec result') ?? {}) as Record<string, unknown>;
        if (record.Running !== true) {
          exitCode = parseCount(record.ExitCode);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { exitCode, stdout, stderr, truncated: started.truncated };
    },

    async archive(name, path, { maxFileBytes = DEFAULT_MAX_BYTES } = {}) {
      requireName(name);
      if (!isArchivePath(path)) {
        throw new DockerSocketError('INVALID_PATH', `${JSON.stringify(path)} is not an absolute path inside the container.`);
      }
      const { status, body, truncated } = await socketRequest(socketPath, {
        method: 'GET',
        path: `/containers/${encodeURIComponent(name)}/archive?path=${encodeURIComponent(path)}`,
        timeoutMs,
        maxBytes: ARCHIVE_MAX_BYTES,
      });
      if (status === 404) {
        throw new DockerSocketError('DOCKER_NOT_FOUND', `${JSON.stringify(path)} does not exist in ${JSON.stringify(name)}.`);
      }
      if (status === 400) {
        throw new DockerSocketError('INVALID_PATH', `${JSON.stringify(path)} cannot be read from ${JSON.stringify(name)}.`);
      }
      if (status !== 200) throw new DockerSocketError('DOCKER_HTTP', `The Docker daemon answered ${status}.`);

      const entries = listTarEntries(body);
      if (entries.length === 0) {
        throw new DockerSocketError('INVALID_PATH', `${JSON.stringify(path)} did not come back as a file or directory.`);
      }
      const first = entries[0]!;
      if (first.type === 'dir') {
        return {
          kind: 'dir',
          entries: entries.map((entry) => ({ name: entry.name, size: entry.size, type: entry.type })),
          truncated,
        };
      }
      if (first.size > maxFileBytes) {
        return { kind: 'too-large', name: first.name, size: first.size };
      }
      return {
        kind: 'file',
        name: first.name,
        size: first.size,
        content: body.subarray(first.dataStart, first.dataStart + first.size),
        truncated,
      };
    },
  };
}
