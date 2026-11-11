import type { HostContainer, HostInfo } from './docker-socket.js';

/**
 * What kind of machine is this?
 *
 * The app only ever sees the daemon, so discovery is derived from the two reads
 * it already has - `/info` and the container list - and never from a product
 * name baked into the logic. A detected manager is a row in MANAGERS, so adding
 * another appliance is a table entry and its evidence is reported alongside the
 * verdict. Everything here is a hint for an agent, deliberately printed with the
 * evidence that produced it.
 */
export type HostManagerDetector = {
  id: string;
  label: string;
  /** Tested against `/info`'s OperatingSystem and KernelVersion. */
  system?: RegExp[];
  /** Tested against container image references. */
  images?: RegExp[];
  /** Tested against container names. */
  names?: RegExp[];
  /** Label keys only this product writes. */
  labels?: string[];
};

export const HOST_MANAGERS: readonly HostManagerDetector[] = [
  { id: 'portainer', label: 'Portainer', names: [/^portainer$/iu], images: [/(^|\/)portainer\/portainer/iu], labels: ['io.portainer.accesscontrol.public'] },
  // Unraid puts its name in the kernel release ("6.12.10-Unraid"), not in the OS string.
  { id: 'unraid', label: 'Unraid', system: [/unraid/iu], names: [/^unraid$/iu] },
  { id: 'mos', label: 'Mos', system: [/(^|[^a-z])mos([^a-z]|$)/iu], names: [/^mos$/iu], images: [/\/mos([:/-]|$)/iu] },
  { id: 'casaos', label: 'CasaOS', names: [/^casaos$/iu], images: [/casaos/iu] },
  { id: 'zimaos', label: 'ZimaOS', system: [/zima/iu], names: [/^zimaos$/iu], images: [/zimaos/iu] },
  { id: 'dockge', label: 'Dockge', names: [/^dockge$/iu], images: [/dockge/iu] },
  { id: 'coolify', label: 'Coolify', names: [/^coolify$/iu], images: [/coolify/iu] },
  { id: 'yacht', label: 'Yacht', names: [/^yacht$/iu], images: [/yacht/iu] },
];

export type HostManagerMatch = { id: string; label: string; evidence: string[] };

export type HostStack = { project: string; services: string[]; containers: string[] };

export type HostProfile = {
  runtime: {
    serverVersion: string;
    operatingSystem: string;
    kernelVersion: string;
    driver: string;
    swarm: string;
    hostName: string;
  };
  managers: HostManagerMatch[];
  /** Containers that hold the daemon socket, i.e. other things that manage it. */
  socketHolders: string[];
  stacks: HostStack[];
  /** Containers nothing declares: started by hand or by a manager's own store. */
  unmanaged: string[];
  guidance: string[];
};

export function detectHost({
  info,
  containers,
  socketPath,
}: {
  info: HostInfo;
  containers: HostContainer[];
  socketPath: string;
}): HostProfile {
  const system = `${info.operatingSystem} ${info.kernelVersion}`.trim();

  const managers = HOST_MANAGERS.flatMap((detector) => {
    const evidence: string[] = [];
    for (const pattern of detector.system ?? []) {
      if (pattern.test(system)) evidence.push(`host reports ${JSON.stringify(system)}`);
    }
    for (const container of containers) {
      if ((detector.names ?? []).some((pattern) => pattern.test(container.name))
        || (detector.images ?? []).some((pattern) => pattern.test(container.image))) {
        evidence.push(`container ${container.name} (${container.image})`);
      }
      for (const key of detector.labels ?? []) {
        if (container.labels[key] !== undefined) evidence.push(`label ${key} on ${container.name}`);
      }
    }
    return evidence.length > 0 ? [{ id: detector.id, label: detector.label, evidence: [...new Set(evidence)] }] : [];
  });

  const socketHolders = containers
    .filter((container) => container.mounts.some((mount) => mount.destination === socketPath || mount.source === socketPath))
    .map((container) => container.name);

  const stacks = new Map<string, HostStack>();
  const unmanaged: string[] = [];
  for (const container of containers) {
    const project = container.labels['com.docker.compose.project'];
    if (!project) {
      unmanaged.push(container.name);
      continue;
    }
    const stack = stacks.get(project) ?? { project, services: [], containers: [] };
    const service = container.labels['com.docker.compose.service'];
    if (service && !stack.services.includes(service)) stack.services.push(service);
    stack.containers.push(container.name);
    stacks.set(project, stack);
  }

  const guidance: string[] = [];
  for (const manager of managers) {
    guidance.push(`${manager.label} is present. Whatever it owns is the source of truth for those containers: change it there, or it will be recreated the way ${manager.label} last defined it.`);
  }
  if (socketHolders.length > 0) {
    guidance.push(`Containers holding the daemon socket: ${socketHolders.join(', ')}. A restart issued here moves a container out from under their view of it.`);
  }
  if (info.swarm === 'active') {
    guidance.push('This daemon is an active Swarm node. Services it manages are restarted by the swarm, not by this app.');
  }
  if (stacks.size > 0) {
    guidance.push('Compose stacks present: ' + [...stacks.keys()].join(', ') + '. A container in a stack is started from the stack file, not by hand.');
  }
  if (unmanaged.length > 0) {
    guidance.push('Containers with no compose project label: ' + unmanaged.join(', ') + '. Nothing declares them, so nothing recreates them.');
  }
  if (managers.length === 0 && socketHolders.length === 0) {
    guidance.push('No known container manager detected: this daemon is probably driven directly by docker or compose on the host.');
  }

  return {
    runtime: {
      serverVersion: info.serverVersion,
      operatingSystem: info.operatingSystem,
      kernelVersion: info.kernelVersion,
      driver: info.driver,
      swarm: info.swarm,
      hostName: info.hostName,
    },
    managers,
    socketHolders,
    stacks: [...stacks.values()],
    unmanaged,
    guidance,
  };
}
