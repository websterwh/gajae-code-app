import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';

/**
 * Read-only host facts behind the generated AGENTS.md.
 *
 * Every probe is a fixed, side-effect-free command or file read, and a missing
 * tool yields nothing instead of an error: the point is to describe whatever
 * host this turns out to be - systemd or OpenRC, glibc or musl, Docker or
 * nothing, disk-backed or image-backed - rather than to demand one particular
 * distro.
 *
 * The probes are generic on purpose. A host that boots a compressed image and
 * keeps its settings on a separate writable partition is not one vendor's
 * product, and neither is one that supervises services with SysV scripts or
 * measures itself with lm-sensors. Detect the shape, not the brand.
 */

export function runCommand(command, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? '').trim(),
        stderr: String(stderr ?? '').trim(),
      });
    });
  });
}

const rows = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

export function parseOsRelease(text) {
  const values = {};
  for (const line of rows(text)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].replace(/^"(.*)"$/u, '$1');
  }
  return {
    id: values.ID ?? null,
    name: values.NAME ?? null,
    prettyName: values.PRETTY_NAME ?? null,
    version: values.VERSION_ID ?? null,
  };
}

const parseNameservers = (text) => rows(text)
  .filter((line) => line.startsWith('nameserver '))
  .map((line) => line.split(/\s+/u)[1])
  .filter(Boolean);

function parsePairs(text) {
  return rows(text).map((line) => {
    const [key, ...rest] = line.split(/\s+/u);
    return { key, value: rest.join(' ') };
  }).filter((pair) => pair.key && pair.value);
}

function parseDisks(text) {
  return rows(text).slice(1).map((line) => {
    const [filesystem, size, used, avail, percent, ...rest] = line.split(/\s+/u);
    return { filesystem, size, used, avail, percent, mount: rest.join(' ') };
  }).filter((disk) => disk.mount);
}

function parseContainers(text) {
  return rows(text).map((line) => {
    const [name, image, status, ports] = line.split('|');
    return { name, image, status, ports: ports ?? '' };
  }).filter((container) => container.name);
}

/** `lsblk -P` emits KEY="value" pairs, which keeps spaces in MODEL intact. */
export function parseBlockDevices(text) {
  return rows(text).map((line) => {
    const fields = {};
    for (const match of line.matchAll(/([A-Z]+)="([^"]*)"/gu)) fields[match[1]] = match[2];
    return {
      name: fields.NAME ?? null,
      size: fields.SIZE ? Number(fields.SIZE) : null,
      type: fields.TYPE ?? null,
      filesystem: fields.FSTYPE || null,
      mount: fields.MOUNTPOINT || null,
      readOnly: fields.RO === '1',
      model: fields.MODEL || null,
    };
  }).filter((device) => device.name);
}

/** Mount entries carry the root filesystem's type and writability, which is
 *  what tells a caller whether writing to `/` will survive a reboot. */
export function parseMounts(text) {
  const decode = (value) => value.replace(/\\040/gu, ' ').replace(/\\011/gu, '\t');
  return rows(text).map((line) => {
    const [device, mount, filesystem, options] = line.split(/\s+/u);
    return {
      device: decode(device ?? ''),
      mount: decode(mount ?? ''),
      filesystem: filesystem ?? null,
      readOnly: (options ?? '').split(',').includes('ro'),
    };
  }).filter((entry) => entry.mount && entry.filesystem);
}

/** `/proc/partitions` is the fallback when `lsblk` is not installed: it
 *  carries names and sizes, but no filesystem, mountpoint or read-only flag. */
export function parsePartitions(text) {
  return rows(text)
    .filter((line) => /^\d+\s+\d+\s+\d+\s+\S+$/u.test(line))
    .map((line) => {
      const [major, minor, blocks, name] = line.split(/\s+/u);
      return { major: Number(major), minor: Number(minor), name, size: Number(blocks) * 1024 };
    })
    .map(({ name, size }) => ({ name, size, type: null, filesystem: null, mount: null, readOnly: false, model: null }));
}

export function parseMeminfo(text) {
  const values = {};
  for (const line of rows(text)) {
    const match = /^([A-Za-z()_]+):\s+(\d+)\s+kB$/u.exec(line);
    if (match) values[match[1]] = Number(match[2]);
  }
  const megabytes = (kilobytes) => (typeof kilobytes === 'number' ? Math.round(kilobytes / 1024) : null);
  const total = megabytes(values.MemTotal);
  const available = megabytes(values.MemAvailable ?? values.MemFree);
  return {
    totalMB: total,
    availableMB: available,
    usedPercent: total && available !== null ? Math.round(((total - available) / total) * 100) : null,
  };
}

function parseSwaps(text) {
  return rows(text).slice(1).map((line) => {
    const [device, type, size, used] = line.split(/\s+/u);
    return {
      device,
      type,
      sizeMB: Math.round(Number(size) / 1024) || null,
      usedMB: Math.round(Number(used) / 1024) || 0,
    };
  }).filter((entry) => entry.device);
}

function parsePools(text) {
  return rows(text).map((line) => {
    const [name, size, allocated, free, health] = line.split(/\s+/u);
    return { name, size, allocated, free, health };
  }).filter((pool) => pool.name && pool.health);
}

function parseUpsc(text) {
  const values = {};
  for (const line of rows(text)) {
    const match = /^([a-z0-9.]+):\s*(.*)$/u.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

/** Filesystems that hold no data of their own, so they are not places to keep
 *  state even when they are writable. */
const VIRTUAL_FILESYSTEMS = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'ramfs', 'cgroup', 'cgroup2',
  'securityfs', 'pstore', 'bpf', 'debugfs', 'tracefs', 'configfs', 'fusectl',
  'mqueue', 'hugetlbfs', 'autofs', 'efivarfs', 'binfmt_misc', 'rpc_pipefs', 'nsfs',
]);

/** Root filesystems that are an image being unpacked rather than a disk being
 *  written, so changes to them are discarded on the next boot. */
const IMAGE_FILESYSTEMS = new Set(['squashfs', 'erofs', 'overlay', 'ramfs', 'tmpfs', 'rootfs', 'cramfs']);

/** Container bookkeeping mounts: writable, but not the operator's storage. */
const RUNTIME_MOUNT = /^\/(?:var\/lib\/docker|run\/docker)(?:\/|$)/u;

const proxyPattern = /godoxy|traefik|caddy|nginx|npm|swag/iu;

export async function collectFacts({
  run = runCommand,
  read = (file) => readFile(file, 'utf8'),
  now = () => new Date(),
  hostnameOf = hostname,
} = {}) {
  const readOr = async (file) => {
    try { return await read(file); } catch { return ''; }
  };
  const sh = async (command) => (await run(command)).stdout;
  const have = async (name) => Boolean(rows(await sh(`command -v ${name} 2>/dev/null`))[0]);

  const osRelease = parseOsRelease(await readOr('/etc/os-release'));
  const initComm = rows(await readOr('/proc/1/comm'))[0] ?? null;
  const initPath = rows(await sh('readlink -f /sbin/init 2>/dev/null'))[0] ?? null;
  const initName = initComm || (initPath ? initPath.split('/').pop() : null);
  const systemctlPath = rows(await sh('command -v systemctl 2>/dev/null'))[0] ?? null;
  const systemd = initName === 'systemd' || Boolean(systemctlPath);
  // One call, one path per tool that exists: this is what tells a non-systemd
  // host which supervision command actually works.
  const serviceTools = rows(await sh('command -v systemctl rc-service rc-status sv rcctl service 2>/dev/null'))
    .map((path) => path.split('/').pop());
  const serviceManager = serviceTools[0] ?? null;
  const serviceList = serviceTools.includes('systemctl')
    ? rows(await sh("systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}'")).slice(0, 20)
    : serviceTools.includes('rc-status')
      ? rows(await sh('rc-status -a 2>/dev/null | head -30'))
      : serviceTools.includes('service')
        ? rows(await sh('service --status-all 2>/dev/null | head -30'))
        : [];
  const packageManagerPath = rows(await sh('command -v apt-get dnf yum apk pacman zypper 2>/dev/null'))[0] ?? null;
  const dockerVersion = rows(await sh('docker version --format "{{.Server.Version}}" 2>/dev/null'))[0] || null;
  const containers = dockerVersion
    ? parseContainers(await sh("docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null"))
    : [];
  const dockerRootDir = dockerVersion
    ? rows(await sh("docker info --format '{{.DockerRootDir}}' 2>/dev/null"))[0] || null
    : null;
  const disks = parseDisks(await sh('df -hP -x tmpfs -x devtmpfs 2>/dev/null'));

  const lsblkDevices = parseBlockDevices(await sh('lsblk -P -l -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,RO,MODEL 2>/dev/null')).slice(0, 40);
  const blockDevices = lsblkDevices.length
    ? lsblkDevices
    : parsePartitions(await readOr('/proc/partitions')).slice(0, 40);
  const mounts = parseMounts(await readOr('/proc/mounts'));
  const rootFilesystem = mounts.find((entry) => entry.mount === '/') ?? null;
  const writableMounts = mounts.filter((entry) => !entry.readOnly
    && !VIRTUAL_FILESYSTEMS.has(entry.filesystem)
    && !IMAGE_FILESYSTEMS.has(entry.filesystem)
    && !RUNTIME_MOUNT.test(entry.mount)
    && entry.mount !== '/');
  const raid = rows(await readOr('/proc/mdstat')).filter((line) => /^md\d+/u.test(line)).slice(0, 8);
  const pools = (await have('zpool'))
    ? parsePools(await sh('zpool list -H -o name,size,alloc,free,health 2>/dev/null'))
    : [];

  const meminfo = parseMeminfo(await readOr('/proc/meminfo'));
  const [one, five, fifteen] = (rows(await readOr('/proc/loadavg'))[0] ?? '').split(/\s+/u).map(Number);
  const loadAverage = {
    one: Number.isFinite(one) ? one : null,
    five: Number.isFinite(five) ? five : null,
    fifteen: Number.isFinite(fifteen) ? fifteen : null,
  };
  const uptimeValue = Number.parseFloat(rows(await readOr('/proc/uptime'))[0] ?? '');
  const uptimeSeconds = Number.isFinite(uptimeValue) ? Math.round(uptimeValue) : null;
  const swapDevices = parseSwaps(await readOr('/proc/swaps'));

  const addresses = parsePairs(await sh("ip -o -4 addr show scope global 2>/dev/null | awk '{print $2\" \"$4}'"))
    .map((pair) => ({ iface: pair.key, address: pair.value }));
  const defaultRoute = rows(await sh('ip -o -4 route show default 2>/dev/null'))[0] ?? null;
  const gateway = /via\s+(\S+)/u.exec(defaultRoute)?.[1] ?? null;
  const ssPath = rows(await sh('command -v ss 2>/dev/null'))[0] ?? null;
  const listeners = ssPath
    ? parsePairs(await sh("ss -lntuH 2>/dev/null | awk '{print $1\" \"$5}'")).map((pair) => ({ proto: pair.key, address: pair.value }))
    : [];

  const timers = systemd ? rows(await sh('systemctl list-timers --all --no-pager --no-legend 2>/dev/null | head -12')) : [];
  const cron = [
    ...rows(await readOr('/etc/crontab')).filter((line) => !line.startsWith('#')),
    ...rows(await sh('crontab -l 2>/dev/null')).filter((line) => !line.startsWith('#')),
  ];
  const cronFiles = rows(await sh('find /etc/cron.d /etc/cron.daily /etc/cron.hourly /etc/cron.weekly /etc/cron.monthly -maxdepth 1 -type f 2>/dev/null | head -20'));

  const lxc = (await have('lxc-ls')) ? rows(await sh('lxc-ls -1 --running 2>/dev/null')).slice(0, 20) : [];
  const vms = (await have('virsh')) ? rows(await sh('virsh list --name 2>/dev/null')).slice(0, 20) : [];

  const temperatures = (await have('sensors'))
    ? rows(await sh('sensors 2>/dev/null')).filter((line) => /\d+(?:\.\d+)?\s*°C/u.test(line)).slice(0, 8)
    : [];
  // NUT names come from the host itself and are validated before they are ever
  // interpolated into the follow-up command.
  const upsNames = (await have('upsc'))
    ? rows(await sh('upsc -l 2>/dev/null')).filter((name) => /^[A-Za-z0-9][A-Za-z0-9@._-]{0,63}$/u.test(name)).slice(0, 4)
    : [];
  const ups = [];
  for (const name of upsNames.slice(0, 1)) {
    ups.push({ name, values: parseUpsc(await sh(`upsc '${name}' 2>/dev/null`)) });
  }

  const lsm = (rows(await readOr('/sys/kernel/security/lsm'))[0] ?? '').split(',').filter(Boolean);
  const cgroupV2 = Boolean(rows(await readOr('/sys/fs/cgroup/cgroup.controllers'))[0]);
  const timezone = rows(await readOr('/etc/timezone'))[0] || Intl.DateTimeFormat().resolvedOptions().timeZone || null;

  const quirks = [];
  const rootImageBacked = rootFilesystem
    && (rootFilesystem.readOnly || IMAGE_FILESYSTEMS.has(rootFilesystem.filesystem));
  if (rootImageBacked) {
    const persistent = writableMounts.map((entry) => entry.mount).slice(0, 6).join(', ') || 'none were found';
    quirks.push(`The root filesystem is ${rootFilesystem.filesystem}${rootFilesystem.readOnly ? ' (read-only)' : ''}: it is an image unpacked at boot, so anything written outside a writable mount is lost on reboot. Writable mounts: ${persistent}. Before installing packages or editing a service, find the OS's own persistent location for that change.`);
  }
  if (initName && !systemd) {
    const alternatives = serviceTools.filter((tool) => tool !== 'systemctl');
    quirks.push(`Init is ${initName}, not systemd: systemctl does not work here${alternatives.length ? `; use ${alternatives.join(' or ')}${alternatives.includes('service') ? ' (SysV) or the scripts in /etc/init.d' : ''}` : ''}.`);
  }
  if (dockerVersion && !containers.length) quirks.push('Docker answers but no containers are running: check whether the daemon was started without the expected stack.');
  const proxy = containers.find((container) => proxyPattern.test(container.name) || proxyPattern.test(container.image));
  if (proxy) quirks.push(`TLS is terminated by the ${proxy.name} container; the app container behind it only ever sees plain HTTP.`);
  const app = containers.find((container) => /gajae/iu.test(container.name) || /gajae/iu.test(container.image));
  if (app) quirks.push(`This GJC deployment runs as container ${app.name}${app.ports ? ` (${app.ports})` : ''}; for file paths and installed tools the container is a different machine from the host.`);
  if (dockerRootDir) quirks.push(`Docker keeps its state under ${dockerRootDir}; on an image-backed or small-boot host that path must be on persistent storage or containers vanish on reboot.`);
  if (!ssPath) quirks.push('`ss` is not installed; use `netstat -lntu` or /proc/net/tcp to see listening sockets.');
  if (!lsblkDevices.length && blockDevices.length) quirks.push('`lsblk` is not installed: the block device list comes from /proc/partitions, which has sizes and names but no filesystem, mountpoint or read-only flag. Use `mount` for the mapping.');
  if (!gateway) quirks.push('No default IPv4 gateway is configured: outbound network access fails until a route is added.');
  if (raid.length) quirks.push(`Software RAID is active (${raid.map((line) => line.split(/\s+/u)[0]).join(', ')}): read /proc/mdstat before touching a member disk.`);
  if (pools.length) quirks.push(`ZFS pools present: ${pools.map((pool) => `${pool.name} (${pool.health})`).join(', ')}: check \`zpool status\` before touching disks, and do not scrub while a backup runs.`);
  if (lxc.length || vms.length) quirks.push(`Workloads beyond Docker are running (LXC: ${lxc.length}, VMs: ${vms.length}); restarting the host affects them too.`);
  if (swapDevices.some((entry) => /zram/u.test(entry.device))) quirks.push('Swap is backed by zram (compressed RAM), not a disk or swapfile: it eases pressure but is not a substitute for free memory.');
  const offlineUps = ups.find((entry) => entry.values['ups.status'] && !/OL/u.test(entry.values['ups.status']));
  if (offlineUps) quirks.push(`The UPS (${offlineUps.name}) reports status ${offlineUps.values['ups.status']}: the host may be on battery or bypass, so treat power as degraded before starting heavy work.`);
  if (lsm.length) quirks.push(`LSM: ${lsm.join(', ')}${lsm.includes('apparmor') ? ' - an AppArmor denial shows up in dmesg, not in the command output that triggered it' : ''}.`);
  if (cgroupV2) quirks.push('cgroup v2 is in use: limits live under /sys/fs/cgroup, and `docker stats` is the reliable per-container view.');
  if (!disks.length) quirks.push('df returned nothing: check `mount` before assuming a path is a separate disk.');

  return {
    collectedAt: now().toISOString(),
    system: {
      hostname: hostnameOf(),
      platform: platform(),
      arch: arch(),
      kernel: release(),
      os: osRelease,
    },
    init: { name: initName, systemd },
    services: { manager: serviceManager, tools: serviceTools, running: serviceList },
    packages: { manager: packageManagerPath ? packageManagerPath.split('/').pop() : null },
    containers: { runtime: dockerVersion ? 'docker' : null, version: dockerVersion, rootDir: dockerRootDir, list: containers },
    virtualization: { lxc, vms },
    resources: {
      cpus: cpus().length,
      memoryMB: Math.round(totalmem() / 1024 / 1024),
      memory: meminfo,
      swap: {
        totalMB: swapDevices.reduce((sum, entry) => sum + (entry.sizeMB ?? 0), 0),
        devices: swapDevices,
      },
      loadAverage,
      uptimeSeconds,
      disks,
    },
    storage: {
      root: rootFilesystem,
      rootImageBacked: Boolean(rootImageBacked),
      writable: writableMounts,
      blockDevices,
      raid,
      pools,
    },
    network: {
      addresses,
      gateway,
      listeners,
      nameservers: parseNameservers(await readOr('/etc/resolv.conf')),
    },
    scheduled: { timers, cron, cronFiles },
    health: { temperatures, ups },
    security: { lsm, cgroupV2 },
    timezone,
    quirks,
  };
}
