import type { HostContainer, HostInfo } from './gjc-docker-socket.js';

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

/** Tested against the daemon's reported hostname. */
type HostPlatformDetector = HostManagerDetector & {
  id: string;
  label: string;
  kind: HostPlatformKind;
  hostnames?: RegExp[];
};

export type HostPlatformKind = 'os' | 'nas' | 'hypervisor' | 'appliance';

/**
 * The machine's own layer: the OS or appliance that owns the host, as opposed
 * to a container manager running on it. Separated from `HOST_MANAGERS` because
 * these answer a different question - "what am I standing on" - and because
 * Proxmox and OpenMediaVault are only visible here: their userland reads as
 * plain Debian, so the kernel, the hostname or their own containers carry the
 * only signal there is.
 */
export const HOST_PLATFORMS: readonly HostPlatformDetector[] = [
  // Unraid puts its name in the kernel release ("6.12.10-Unraid"), not in the OS string.
  { id: 'unraid', label: 'Unraid', kind: 'nas', system: [/unraid/iu], hostnames: [/^unraid$/iu] },
  // MOS ships a Devuan base with its own kernel suffix ("6.12.10-mos").
  { id: 'mos', label: 'MOS', kind: 'os', system: [/(^|[^a-z])mos([^a-z]|$)/iu], names: [/^mos$/iu], images: [/(^|\/)mos([:/-]|$)/iu] },
  // Proxmox keeps Debian's userland and marks only the kernel ("6.6.8-1-pve"),
  // so the OS string alone would read as plain Debian inside a guest.
  { id: 'proxmox', label: 'Proxmox VE', kind: 'hypervisor', system: [/\bpve\b|proxmox/iu] },
  // OpenMediaVault is Debian with its own web UI; docker is an add-on there, so
  // the hostname and its own container are the signals, not the kernel.
  { id: 'openmediavault', label: 'OpenMediaVault', kind: 'nas', system: [/openmediavault/iu], hostnames: [/^openmediavault$/iu], names: [/^openmediavault$/iu], images: [/openmediavault/iu] },
  { id: 'casaos', label: 'CasaOS', kind: 'appliance', system: [/casaos/iu], hostnames: [/^casaos$/iu], names: [/^casaos([-_.]|$)/iu], images: [/casaos/iu] },
  { id: 'zimaos', label: 'ZimaOS', kind: 'os', system: [/zima/iu], names: [/^zimaos([-_.]|$)/iu], images: [/zimaos/iu] },
];

export const HOST_MANAGERS: readonly HostManagerDetector[] = [
  { id: 'portainer', label: 'Portainer', names: [/^portainer$/iu], images: [/(^|\/)portainer\/portainer/iu], labels: ['io.portainer.accesscontrol.public'] },
  { id: 'dockge', label: 'Dockge', names: [/^dockge$/iu], images: [/dockge/iu] },
  { id: 'coolify', label: 'Coolify', names: [/^coolify$/iu], images: [/coolify/iu] },
  { id: 'yacht', label: 'Yacht', names: [/^yacht$/iu], images: [/yacht/iu] },
];

export type HostManagerMatch = { id: string; label: string; evidence: string[] };

export type HostPlatformMatch = HostManagerMatch & { kind: HostPlatformKind };

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
  /** The OS or appliance this daemon runs on, with its evidence. */
  platforms: HostPlatformMatch[];
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

  const evidenceFor = (
    detector: { system?: RegExp[]; hostnames?: RegExp[]; names?: RegExp[]; images?: RegExp[]; labels?: string[] },
  ): string[] => {
    const evidence: string[] = [];
    for (const pattern of detector.system ?? []) {
      if (pattern.test(system)) evidence.push(`host reports ${JSON.stringify(system)}`);
    }
    for (const pattern of detector.hostnames ?? []) {
      if (info.hostName && pattern.test(info.hostName)) evidence.push(`hostname ${JSON.stringify(info.hostName)}`);
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
    // One line per signal, not per container it matched: five casaos-* helpers
    // are one fact, not five.
    return [...new Set(evidence)];
  };

  const platforms: HostPlatformMatch[] = HOST_PLATFORMS.flatMap((detector) => {
    const evidence = evidenceFor(detector);
    return evidence.length > 0
      ? [{ id: detector.id, label: detector.label, kind: detector.kind, evidence }]
      : [];
  });

  const managers: HostManagerMatch[] = HOST_MANAGERS.flatMap((detector) => {
    const evidence = evidenceFor(detector);
    return evidence.length > 0 ? [{ id: detector.id, label: detector.label, evidence }] : [];
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
  for (const platform of platforms) {
    guidance.push(platform.kind === 'hypervisor'
      ? `${platform.label} provides this kernel: the daemon is a ${platform.label} guest, so the machine's own storage and networking are managed there, not here.`
      : `${platform.label} is this machine's own layer. It is the source of truth for what runs on that layer: change it there, or it may recreate it the way it last defined it.`);
  }
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
  if (managers.length === 0 && socketHolders.length === 0 && platforms.length === 0) {
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
    platforms,
    managers,
    socketHolders,
    stacks: [...stacks.values()],
    unmanaged,
    guidance,
  };
}
