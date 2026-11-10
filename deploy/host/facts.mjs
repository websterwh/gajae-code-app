import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';

/**
 * Read-only host facts behind the generated AGENTS.md.
 *
 * Every probe is a fixed, side-effect-free command or file read, and a missing
 * tool yields null instead of an error: the point is to describe whatever host
 * this turns out to be - systemd or OpenRC, glibc or musl, Docker or nothing -
 * rather than to demand one particular distro.
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

  const osRelease = parseOsRelease(await readOr('/etc/os-release'));
  const initComm = rows(await readOr('/proc/1/comm'))[0] ?? null;
  const initPath = rows(await sh('readlink -f /sbin/init 2>/dev/null'))[0] ?? null;
  const initName = initComm || (initPath ? initPath.split('/').pop() : null);
  const systemctlPath = rows(await sh('command -v systemctl 2>/dev/null'))[0] ?? null;
  const systemd = initName === 'systemd' || Boolean(systemctlPath);
  const packageManagerPath = rows(await sh('command -v apt-get dnf yum apk pacman zypper 2>/dev/null'))[0] ?? null;
  const dockerVersion = rows(await sh('docker version --format "{{.Server.Version}}" 2>/dev/null'))[0] || null;
  const containers = dockerVersion
    ? parseContainers(await sh("docker ps --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' 2>/dev/null"))
    : [];
  const disks = parseDisks(await sh('df -hP -x tmpfs -x devtmpfs 2>/dev/null'));
  const addresses = parsePairs(await sh("ip -o -4 addr show scope global 2>/dev/null | awk '{print $2\" \"$4}'"))
    .map((pair) => ({ iface: pair.key, address: pair.value }));
  const ssPath = rows(await sh('command -v ss 2>/dev/null'))[0] ?? null;
  const listeners = ssPath
    ? parsePairs(await sh("ss -lntuH 2>/dev/null | awk '{print $1\" \"$5}'")).map((pair) => ({ proto: pair.key, address: pair.value }))
    : [];
  const timers = systemd ? rows(await sh('systemctl list-timers --all --no-pager --no-legend 2>/dev/null | head -12')) : [];
  const cron = [
    ...rows(await readOr('/etc/crontab')).filter((line) => !line.startsWith('#')),
    ...rows(await sh('crontab -l 2>/dev/null')).filter((line) => !line.startsWith('#')),
  ];
  const lsm = (rows(await readOr('/sys/kernel/security/lsm'))[0] ?? '').split(',').filter(Boolean);
  const cgroupV2 = Boolean(rows(await readOr('/sys/fs/cgroup/cgroup.controllers'))[0]);
  const timezone = rows(await readOr('/etc/timezone'))[0] || Intl.DateTimeFormat().resolvedOptions().timeZone || null;

  const quirks = [];
  if (initName && !systemd) quirks.push(`Init is ${initName}, not systemd: systemctl does not work here, so use the init's own service tool or the init scripts directly.`);
  if (dockerVersion && !containers.length) quirks.push('Docker answers but no containers are running: check whether the daemon was started without the expected stack.');
  const proxy = containers.find((container) => proxyPattern.test(container.name) || proxyPattern.test(container.image));
  if (proxy) quirks.push(`TLS is terminated by the ${proxy.name} container; the app container behind it only ever sees plain HTTP.`);
  const app = containers.find((container) => /gajae/iu.test(container.name) || /gajae/iu.test(container.image));
  if (app) quirks.push(`This GJC deployment runs as container ${app.name}${app.ports ? ` (${app.ports})` : ''}; for file paths and installed tools the container is a different machine from the host.`);
  if (!ssPath) quirks.push('`ss` is not installed; use `netstat -lntu` or /proc/net/tcp to see listening sockets.');
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
    packages: { manager: packageManagerPath ? packageManagerPath.split('/').pop() : null },
    containers: { runtime: dockerVersion ? 'docker' : null, version: dockerVersion, list: containers },
    resources: {
      cpus: cpus().length,
      memoryMB: Math.round(totalmem() / 1024 / 1024),
      disks,
    },
    network: {
      addresses,
      listeners,
      nameservers: parseNameservers(await readOr('/etc/resolv.conf')),
    },
    scheduled: { timers, cron },
    security: { lsm, cgroupV2 },
    timezone,
    quirks,
  };
}
