import { spawn } from 'node:child_process';
import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { bundledCatalog, type CatalogEntry } from './catalog.js';
import { recordFailure, recordInstalled, type InstallManager, type Ledger, type LedgerEntry } from './ledger.js';
import { packageSpecFromEntry, type McpServerEntry } from './mcp.config.js';
import { normalizePin, parsePackageSpec, pinnedSpec } from './pins.js';

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<CommandResult>;

export type ProvisionOutcome = {
  manager: InstallManager;
  name: string;
  spec: string;
  status: 'installed' | 'failed';
  version: string | null;
  error?: string;
  /** `verified` means the pre-install check found a healthy install, so no install ran. */
  action?: 'verified' | 'installed';
};

export type ProvisionProgress = { manager: InstallManager; package: string; command: string };

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The last few stderr lines are the part a boot log can actually use. */
export function tailLines(text: string, count = 5): string {
  const lines = String(text ?? '').trim().split(/\r?\n/u).filter(Boolean);
  return lines.slice(-count).join(' | ');
}

/**
 * Google ships no Debian package for the Android SDK, and `sdkmanager` is the
 * only supported way to fetch its components. The first install puts Google's
 * command-line tools into the SDK root on the config mount - so a recreate
 * keeps both the download and the licenses that were accepted - and every
 * install after that is one `sdkmanager --install`. The component arrives as
 * `$1`, never interpolated into the script.
 */
const ANDROID_INSTALL = [
  'set -e',
  'root="${ANDROID_SDK_ROOT}"',
  'tools="$root/cmdline-tools/latest/bin/sdkmanager"',
  'if [ ! -x "$tools" ]; then',
  '  command -v curl >/dev/null 2>&1 || apt-get install -y -qq curl >/dev/null',
  '  command -v unzip >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq unzip >/dev/null; }',
  '  tmp=$(mktemp -d)',
  '  trap \'rm -rf "$tmp"\' EXIT',
  '  curl -fsSL "${ANDROID_CMDLINE_TOOLS_URL:-https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip}" -o "$tmp/tools.zip"',
  '  unzip -q "$tmp/tools.zip" -d "$tmp"',
  '  rm -rf "$root/cmdline-tools/latest"',
  '  mkdir -p "$root/cmdline-tools"',
  '  mv "$tmp/cmdline-tools" "$root/cmdline-tools/latest"',
  'fi',
  'export ANDROID_HOME="$root" ANDROID_SDK_ROOT="$root"',
  // The licenses belong to whoever asked for the component, and a
  // non-interactive install cannot answer the prompt; `yes` reads them as
  // accepted, which is what installing through this page means anyway.
  'yes | "$tools" --licenses >/dev/null 2>&1 || true',
  '"$tools" --install "$1" >/dev/null',
  // sdkmanager lives under the SDK root, which is not on PATH; the mount's bin
  // directory already is, and the entrypoint re-exports it on every boot.
  'bin="${UV_TOOL_BIN_DIR:-$root/../app/bin}"',
  'mkdir -p "$bin"',
  'ln -sf "$root/cmdline-tools/latest/bin/sdkmanager" "$bin/sdkmanager"',
  'ln -sf "$root/cmdline-tools/latest/bin/avdmanager" "$bin/avdmanager"',
  '{ [ -x "$root/platform-tools/adb" ] && ln -sf "$root/platform-tools/adb" "$bin/adb"; } || true',
].join('\n');

/**
 * An installed component is a directory under the SDK root, and its
 * `source.properties` carries the revision apt would call a version:
 * `platforms;android-35` lives in `platforms/android-35` and reads
 * `Pkg.Revision=35.0.0`.
 */
const ANDROID_VERIFY = [
  'root="${ANDROID_SDK_ROOT}"',
  'rel=$(printf "%s" "$1" | tr ";" "/")',
  'props="$root/$rel/source.properties"',
  '[ -f "$props" ] || exit 1',
  'sed -n "s/^Pkg.Revision=//p" "$props" | head -n 1',
].join('\n');

const ANDROID_UNINSTALL = [
  'root="${ANDROID_SDK_ROOT}"',
  'tools="$root/cmdline-tools/latest/bin/sdkmanager"',
  '[ -x "$tools" ] || exit 0',
  'export ANDROID_HOME="$root" ANDROID_SDK_ROOT="$root"',
  '"$tools" --uninstall "$1"',
].join('\n');

export function installCommand(
  manager: InstallManager,
  parsed: ReturnType<typeof parsePackageSpec>,
  pin: string | null | undefined,
): { command: string; args: string[] } {
  const spec = pinnedSpec(parsed, pin, manager);
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'install', '-q', spec] };
    case 'pip':
      // Debian marks its interpreter externally managed (PEP 668), and uv
      // refuses a --system install there without this flag: every pip row
      // failed with the EXTERNALLY-MANAGED banner and the pipx hint instead
      // of installing. The container is root, nothing else owns the
      // interpreter, and the pip manager exists to make a package importable
      // by the system python, so the override is what `--system` means here.
      return { command: 'uv', args: ['pip', 'install', '-q', '--system', '--break-system-packages', spec] };
    case 'npm':
      return { command: 'npm', args: ['install', '-g', '--no-fund', '--no-audit', spec] };
    case 'aqua':
      return { command: 'install-github-app', args: [spec] };
    case 'apt':
      // No shell: the spec is an argument, so a crafted name cannot become a
      // second command. force-conf* keeps a config-file prompt from wedging a
      // non-interactive install.
      return {
        command: 'apt-get',
        args: ['install', '-y', '-qq', '--no-install-recommends',
          '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', spec],
      };
    case 'android':
      // The component is `$1` for the same reason: it names a path under the
      // SDK root (`tr ; /`), so it must never become part of the script.
      return { command: 'sh', args: ['-c', ANDROID_INSTALL, 'sh', spec] };
  }
}

/** `skylot/jadx` installs a `jadx` binary; a generic aqua package writes /data/aqua/aqua.yaml. */
function aquaBinary(name: string): string {
  const last = name.split('/').filter(Boolean).pop() ?? name;
  return last.replace(/\.git$/u, '').toLowerCase();
}

/**
 * `aqua list` needs an aqua.yaml, which only the generic fallback writes, so
 * the installer's special handlers (jadx, apktool) failed verification with
 * "configuration file isn't found" after a perfectly good install. Check the
 * binary the installer linked into PATH first, then the aqua config.
 */
const AQUA_VERIFY = [
  // The installer records the release tag it fetched; without it an aqua
  // package has a binary but no version to show or pin.
  'bin=$(command -v "$1" 2>/dev/null) && { printf "%s\\n" "$bin"; cat "${GITHUB_APPS_STATE:-/data/share/github-apps.json}" 2>/dev/null; exit 0; }',
  'cfg="${AQUA_ROOT_DIR:-/data/aqua}/aqua.yaml"',
  '[ -f "$cfg" ] && aqua list -c "$cfg" 2>/dev/null | grep -F -- "$2"',
].join('; ');

/**
 * Tool state belongs on the mounted agent config, not in the container's
 * writable layer: without these two variables `uv tool install` writes to
 * ~/.local/share/uv and its binaries to ~/.local/bin, both inside the image,
 * and every package the user added was gone after a recreate. The image's
 * entrypoint exports the same values; deriving them here as well keeps the
 * Settings page installing onto the mount even when the app was started by
 * something that did not read the entrypoint.
 */
function configRoot(base: NodeJS.ProcessEnv): string {
  const agentDir = base.GJC_WORKER_AGENT_DIR || path.join(homedir(), '.gjc', 'agent');
  return path.dirname(agentDir);
}

/**
 * Where the Android SDK lives: beside the other tool state on the config
 * mount, unless the container names a root itself. Google publishes no Debian
 * package for the SDK, so this is all the `android` manager needs to know
 * before `sdkmanager` takes over.
 */
export function androidSdkRoot(base: NodeJS.ProcessEnv = process.env): string {
  return base.ANDROID_SDK_ROOT || base.ANDROID_HOME || path.join(configRoot(base), 'android-sdk');
}

export function provisionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const toolDir = base.UV_TOOL_DIR || path.join(configRoot(base), 'app', 'uv');
  const binDir = base.UV_TOOL_BIN_DIR || path.join(configRoot(base), 'app', 'bin');
  const sdkRoot = androidSdkRoot(base);
  const pathEntries = (base.PATH ?? '').split(':').filter(Boolean);
  const wanted = [binDir, path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin'), path.join(sdkRoot, 'platform-tools')];
  const searchPath = [...wanted.filter((entry) => !pathEntries.includes(entry)), ...pathEntries].join(':');
  return {
    ...base,
    UV_TOOL_DIR: toolDir,
    UV_TOOL_BIN_DIR: binDir,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    PATH: searchPath,
  };
}

/** The one process runner both boot provisioning and the HTTP API use. */
export function spawnCommandRunner(): CommandRunner {
  const env = provisionEnv();
  return (command, args, options) => new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export function verifyCommand(manager: InstallManager, name: string): { command: string; args: string[] } {
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'list'] };
    case 'pip':
      // Without --system this looks for a virtual environment, landed on the
      // image's own uv-managed interpreter and reported every package the
      // install above wrote to /usr as missing, so a good install read failed.
      return { command: 'uv', args: ['pip', 'show', '--system', name] };
    case 'npm':
      return { command: 'npm', args: ['ls', '-g', '--json', '--depth=0', name] };
    case 'aqua':
      return { command: 'sh', args: ['-c', AQUA_VERIFY, 'sh', aquaBinary(name), name] };
    case 'apt':
      return { command: 'dpkg-query', args: ['-W', '-f=${Status}\t${Version}\n', name] };
    case 'android':
      return { command: 'sh', args: ['-c', ANDROID_VERIFY, 'sh', name] };
  }
}

export type UninstallOutcome = { status: 'removed' | 'failed'; command: string; error?: string };

/**
 * The reverse of installCommand. `aqua` goes back through the installer
 * script, which is the only thing that knows where a release, the jadx and
 * apktool layouts and the aqua cache actually put their files.
 */
export function uninstallCommand(manager: InstallManager, spec: string): { command: string; args: string[] } {
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'uninstall', spec] };
    case 'pip':
      return { command: 'uv', args: ['pip', 'uninstall', '--system', '--break-system-packages', spec] };
    case 'npm':
      return { command: 'npm', args: ['uninstall', '-g', spec] };
    case 'aqua':
      // `skylot/jadx@v1.5.1` names a release; the script looks up the repo.
      return { command: 'install-github-app', args: ['--uninstall', spec.split('@')[0] ?? spec] };
    case 'apt':
      return {
        command: 'apt-get',
        args: ['remove', '-y', '-qq', '-o', 'Dpkg::Options::=--force-confdef',
          '-o', 'Dpkg::Options::=--force-confold', spec],
      };
    case 'android':
      return { command: 'sh', args: ['-c', ANDROID_UNINSTALL, 'sh', spec] };
  }
}

/**
 * "Nothing to remove" is not a failure to remove: a row can be listed from the
 * ledger after the binary was already deleted by hand, and the user still
 * wants it gone from the list.
 */
function alreadyGone(output: string, code: number): boolean {
  if (code === 100) return true; // apt-get: no such package installed
  return /not installed|isn't installed|not currently installed|not found|no such package/iu.test(output);
}

/**
 * An uninstall removes the binary but not always the PATH entry the installer
 * put there, and a dangling link shadows the working one further down PATH:
 * `zoxide` answered "No such file or directory" from a dead /data/bin shim
 * while apt's /usr/bin/zoxide was installed. Only links whose target is gone
 * are touched, one level deep, and never a real file.
 */
export function pruneDanglingLinks(names: string[], pathValue: string = process.env.PATH ?? ''): string[] {
  const removed: string[] = [];
  const visited = new Set<string>();
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory || visited.has(directory)) continue;
    visited.add(directory);
    for (const name of names) {
      if (!name) continue;
      const link = path.join(directory, name);
      try {
        if (!lstatSync(link).isSymbolicLink() || existsSync(link)) continue;
        unlinkSync(link);
        removed.push(link);
      } catch {
        // Absent, or not ours to remove.
      }
    }
  }
  return removed;
}

export async function uninstallPackage(options: {
  manager: InstallManager;
  /** The stored spec: `serena`, `serena==1.2.3`, `skylot/jadx@v1.5.1`. */
  spec: string;
  runner: CommandRunner;
}): Promise<UninstallOutcome> {
  const parsed = parsePackageSpec(options.spec);
  const target = options.manager === 'aqua' ? options.spec : parsed.name;
  if (!target) throw new Error('The package spec has no name.');
  const command = uninstallCommand(options.manager, target);
  const printable = [command.command, ...command.args].join(' ');
  const result = await options.runner(command.command, command.args);
  if (result.code !== 0 && !alreadyGone(`${result.stdout}\n${result.stderr}`, result.code)) {
    return {
      status: 'failed',
      command: printable,
      error: `exit ${result.code}: ${tailLines(result.stderr || result.stdout)}`,
    };
  }
  pruneDanglingLinks([parsed.name]);
  return { status: 'removed', command: printable };
}

/** `uv tool list` prints each registered distribution, then its executables indented under it. */
export function parseUvToolInventory(output: string): Array<{ name: string; executables: string[] }> {
  const tools: Array<{ name: string; executables: string[] }> = [];
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const header = /^(\S+)\s+v(\S+)\s*$/u.exec(line);
    if (header?.[1]) {
      tools.push({ name: header[1], executables: [] });
      continue;
    }
    const executable = /^\s*-\s+(\S+)\s*$/u.exec(line);
    const current = tools[tools.length - 1];
    if (executable?.[1] && current) current.executables.push(executable[1]);
  }
  return tools;
}

/**
 * The version of the distribution a name resolves to. `uv tool list` reports
 * `serena-agent v2.1.1.dev0` while the spec asks for `serena`, so matching the
 * spec name alone finds nothing and the ledger kept a null version - which left
 * the packages page with no version to pin.
 */
export function uvToolVersion(output: string, name: string): string | null {
  let distribution: string | null = null;
  let version: string | null = null;
  for (const line of String(output ?? '').split(/\r?\n/u)) {
    const header = /^(\S+)\s+v(\S+)\s*$/u.exec(line);
    if (header?.[1]) {
      if (distribution === name) return version;
      distribution = header[1];
      version = header[2] ?? null;
      continue;
    }
    const executable = /^\s*-\s+(\S+)\s*$/u.exec(line);
    if (executable?.[1] === name && distribution) return version;
  }
  return distribution === name ? version : null;
}

/**
 * `apt-get install android-tools-adb` installs `adb` on images where that name
 * is only a virtual package: dpkg answers `unknown ok not-installed` for the
 * name that was asked for while its provider sits installed, so a good install
 * was recorded as failed with nothing in the inventory.
 */
export async function aptProviderVersion(runner: CommandRunner, name: string): Promise<string | null> {
  const result = await runner('dpkg-query', ['-W', '-f=${Package}\t${Status}\t${Version}\t${Provides}\n']);
  if (result.code !== 0) return null;
  for (const line of String(result.stdout ?? '').split(/\r?\n/u)) {
    const [pkg, status, version, provides] = line.split('\t');
    if (!pkg || status?.trim() !== 'install ok installed') continue;
    const provided = String(provides ?? '').split(',').map((entry) => entry.trim().split(/\s+/u)[0]);
    if (pkg === name || provided.includes(name)) return version?.trim() ?? null;
  }
  return null;
}

/** dpkg's own answer first; an apt virtual name then falls back to a provider. */
async function detectedOrProvided(
  manager: InstallManager,
  name: string,
  output: string,
  runner: CommandRunner,
): Promise<string | null> {
  const detected = detectedVersion(manager, name, output);
  if (detected !== null || manager !== 'apt') return detected;
  return aptProviderVersion(runner, name);
}

/** uv needs the inventory, not a bare name match, to answer with a version. */
function detectedVersion(manager: InstallManager, name: string, output: string): string | null {
  if (manager === 'uv') return uvToolVersion(output, name) ?? parseInstalledVersion(manager, name, output);
  return parseInstalledVersion(manager, name, output);
}

/**
 * The name a spec asks for is not always the name uv registered: installing
 * `git+https://github.com/oraios/serena` registers `serena-agent` and exposes a
 * `serena` command. Upgrading by the spec name failed with "not installed",
 * which looked like a missing tool and reinstalled it on every boot.
 */
async function registeredUvTool(runner: CommandRunner, name: string): Promise<string | null> {
  const result = await runner('uv', ['tool', 'list']);
  if (result.code !== 0) return null;
  const tools = parseUvToolInventory(result.stdout);
  const match = tools.find((tool) => tool.name === name)
    ?? tools.find((tool) => tool.executables.includes(name));
  return match?.name ?? null;
}

/** Exit 0 alone is not proof: `uv tool list` succeeds on an empty tool set. */
function verificationConfirms(manager: InstallManager, name: string, output: string, version: string | null): boolean {
  if (manager === 'uv') return version !== null || output.includes(name);
  // A binary on PATH is not proof the installer put it there. The base image
  // ships tools the installer also knows, so `command -v zoxide` succeeded for
  // a package that was never installed: the row read "installed" with no
  // version, nothing was fetched, and there was nothing to pin or upgrade.
  // The release tag aqua wrote into its state file is the only evidence an
  // aqua install actually happened.
  if (manager === 'aqua') return version !== null;
  return version !== null;
}

export function parseInstalledVersion(manager: InstallManager, name: string, output: string): string | null {
  switch (manager) {
    case 'uv': {
      const match = new RegExp(`^\\s*${escapeRegExp(name)}\\s+v?(\\S+)\\s*$`, 'mu').exec(output);
      return match?.[1] ?? null;
    }
    case 'pip': {
      const match = /^Version:\s*(\S+)\s*$/mu.exec(output);
      return match?.[1] ?? null;
    }
    case 'npm': {
      try {
        const parsed = JSON.parse(output) as { dependencies?: Record<string, { version?: string }> };
        return parsed.dependencies?.[name]?.version ?? null;
      } catch {
        return null;
      }
    }
    case 'aqua': {
      // The verify output carries the installer's state file, which prints each
      // release as `"skylot/jadx": "1.5.1"`.
      const match = new RegExp(`"${escapeRegExp(name)}"\\s*:\\s*"([^"]+)"`, 'u').exec(output);
      return match?.[1] ?? null;
    }
    case 'apt': {
      // `dpkg-query -W -f='${Status}\t${Version}'` prints `install ok installed\t1.2.3`
      // for a known package, and exits non-zero when the name is unknown.
      const match = /^install ok installed\s+(\S+)/mu.exec(output);
      return match?.[1] ?? null;
    }
    case 'android': {
      // The verify script prints `Pkg.Revision` alone: `35.0.0` for a platform,
      // `21.0.1` for the command-line tools.
      const match = /^\s*(\d+(?:\.\d+)*)\s*$/mu.exec(output);
      return match?.[1] ?? null;
    }
  }
}

/**
 * Install each package, verify it, and write the ledger only on success.
 *
 * A failed install is logged with its command, exit code and the tail of the
 * error, recorded as failed, and skipped so the remaining packages still get
 * their turn. A failed entry is never mistaken for an installed one, so the
 * next boot retries it.
 */
export async function provisionPackages(options: {
  manager: InstallManager;
  packages: string[];
  ledger: Ledger;
  runner: CommandRunner;
  pins?: Record<string, string | null>;
  log?: (line: string) => void;
  onProgress?: (progress: ProvisionProgress) => void | Promise<void>;
  now?: () => string;
}): Promise<ProvisionOutcome[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date().toISOString());
  const outcomes: ProvisionOutcome[] = [];

  for (const raw of options.packages) {
    const parsed = parsePackageSpec(raw);
    if (!parsed.name) continue;
    const pin = normalizePin(options.pins?.[parsed.name]);
    const spec = pinnedSpec(parsed, pin, options.manager);
    // Verify first: a healthy install is left alone, so a reboot costs one
    // local command per package instead of a networked install. A pin the
    // installed version does not satisfy is not healthy.
    const preflight = verifyCommand(options.manager, parsed.name);
    const preflightResult = await options.runner(preflight.command, preflight.args);
    // A virtual apt name is not installed under its own name, so `dpkg-query`
    // exits non-zero even when the package that provides it is right there.
    // Asking the providers is the only answer for that name, and it is what
    // keeps such a package from being reinstalled on every boot.
    const preflightVersion = preflightResult.code === 0
      ? await detectedOrProvided(options.manager, parsed.name, preflightResult.stdout, options.runner)
      : (options.manager === 'apt' ? await aptProviderVersion(options.runner, parsed.name) : null);
    const preflightHealthy = (preflightResult.code === 0 || preflightVersion !== null)
      && verificationConfirms(options.manager, parsed.name, preflightResult.stdout, preflightVersion)
      && (!pin || preflightVersion === null || preflightVersion === pin);
    if (preflightHealthy) {
      const version = preflightVersion ?? pin ?? parsed.version;
      recordInstalled(options.ledger, options.manager, parsed.name, { spec, version, pin, at: now() });
      log(`[${options.manager}] ${parsed.name}${version ? ` ${version}` : ''} is present; verified.`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'installed', version, action: 'verified' });
      continue;
    }

    // apt resolves names against a local index the image built at build time.
    // It ages out, so refresh it once per install; a network failure here only
    // means apt-get install reports the stale index, which is accurate.
    if (options.manager === 'apt') await options.runner('apt-get', ['update', '-qq']);

    const install = installCommand(options.manager, parsed, pin);
    const printable = [install.command, ...install.args].join(' ');
    await options.onProgress?.({ manager: options.manager, package: parsed.name, command: printable });

    const result = await options.runner(install.command, install.args);
    if (result.code !== 0) {
      const error = `exit ${result.code}: ${tailLines(result.stderr || result.stdout)}`;
      recordFailure(options.ledger, options.manager, parsed.name, spec, error, now());
      log(`[${options.manager}] ${parsed.name} failed (${error}) - command: ${printable}`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'failed', version: null, error });
      continue;
    }

    const verify = verifyCommand(options.manager, parsed.name);
    const verified = await options.runner(verify.command, verify.args);
    // The same virtual-name gap after the install: apt installed the provider
    // and exits 0, then `dpkg-query` still knows nothing about the name that
    // was asked for. A provider version is a successful install, not a failure.
    const providedVersion = verified.code !== 0 && options.manager === 'apt'
      ? await aptProviderVersion(options.runner, parsed.name)
      : null;
    if (verified.code !== 0 && providedVersion === null) {
      const error = `install exited 0 but verification failed (exit ${verified.code}): ${tailLines(verified.stderr || verified.stdout)}`;
      recordFailure(options.ledger, options.manager, parsed.name, spec, error, now());
      log(`[${options.manager}] ${parsed.name} failed verification - command: ${printable}`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'failed', version: null, error });
      continue;
    }

    // `latest` is resolved here, at install time, and the concrete version is
    // what the ledger (and the UI) records as actually running.
    const detected = providedVersion
      ?? await detectedOrProvided(options.manager, parsed.name, verified.stdout, options.runner);
    if (!verificationConfirms(options.manager, parsed.name, verified.stdout, detected)) {
      const error = 'install exited 0 but the package is not present in the tool inventory';
      recordFailure(options.ledger, options.manager, parsed.name, spec, error, now());
      log(`[${options.manager}] ${parsed.name} failed verification - command: ${printable}`);
      outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'failed', version: null, error });
      continue;
    }
    const version = detected ?? pin ?? parsed.version;
    recordInstalled(options.ledger, options.manager, parsed.name, { spec, version, pin, at: now() });
    log(`[${options.manager}] ${parsed.name}${version ? ` ${version}` : ''} installed.`);
    outcomes.push({ manager: options.manager, name: parsed.name, spec, status: 'installed', version, action: 'installed' });
  }

  return outcomes;
}

/** One package, one upgrade attempt. A pinned entry is never passed here. */
export async function upgradePackage(options: {
  manager: InstallManager;
  name: string;
  entry: LedgerEntry;
  ledger: Ledger;
  runner: CommandRunner;
  log?: (line: string) => void;
  now?: () => string;
}): Promise<ProvisionOutcome> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date().toISOString());
  const { manager, name, entry, ledger, runner } = options;
  const parsed = parsePackageSpec(entry.spec);
  // Upgrade what is actually registered, so a git checkout that installed
  // under a different distribution name is not mistaken for a missing tool.
  const registered = manager === 'uv' ? await registeredUvTool(runner, name) : null;
  const upgrade = upgradeCommand(manager, { ...parsed, name: registered ?? parsed.name });
  const result = await runner(upgrade.command, upgrade.args);
  if (result.code !== 0) {
    const detail = tailLines(result.stderr || result.stdout);
    // `uv tool upgrade` refuses a tool that is missing from the inventory and
    // tells you to install it. Installing is the recovery; retrying the
    // upgrade every boot is what left the entry failed forever.
    if (manager === 'uv' && /not installed/iu.test(detail)) {
      log(`[uv] ${name} is missing from the tool inventory; installing it again.`);
      const reinstall = installCommand(manager, parsed, null);
      const retried = await runner(reinstall.command, reinstall.args);
      if (retried.code !== 0) {
        const error = `reinstall exit ${retried.code}: ${tailLines(retried.stderr || retried.stdout)}`;
        recordFailure(ledger, manager, name, entry.spec, error, now());
        log(`[uv] ${name} reinstall failed (exit ${retried.code}).`);
        return { manager, name, spec: entry.spec, status: 'failed', version: null, error };
      }
    } else {
      // An update is opportunistic, so a release lookup that fails (a GitHub
      // rate limit, an offline box) must not turn a working binary into a
      // failed row: verify the package and keep it installed when it is there.
      const verify = verifyCommand(manager, name);
      const present = await runner(verify.command, verify.args);
      const presentVersion = present.code === 0
        ? await detectedOrProvided(manager, name, present.stdout, runner)
        : null;
      if (present.code === 0 && verificationConfirms(manager, name, present.stdout, presentVersion)) {
        const version = presentVersion ?? entry.version;
        recordInstalled(ledger, manager, name, { spec: entry.spec, version, pin: null, at: now() });
        log(`[${manager}] ${name} is installed; the update check failed (exit ${result.code}).`);
        return { manager, name, spec: entry.spec, status: 'installed', version, action: 'verified' };
      }
      const error = `update exit ${result.code}: ${detail}`;
      recordFailure(ledger, manager, name, entry.spec, error, now());
      log(`[${manager}] ${name} update failed (exit ${result.code}).`);
      return { manager, name, spec: entry.spec, status: 'failed', version: null, error };
    }
  }
  const verify = verifyCommand(manager, name);
  const verified = await runner(verify.command, verify.args);
  const detected = verified.code === 0 ? await detectedOrProvided(manager, name, verified.stdout, runner) : null;
  if (verified.code !== 0 || !verificationConfirms(manager, name, verified.stdout, detected)) {
    const error = 'update verification failed';
    recordFailure(ledger, manager, name, entry.spec, error, now());
    return { manager, name, spec: entry.spec, status: 'failed', version: null, error };
  }
  const version = detected ?? entry.version;
  if (version && entry.version && version !== entry.version) {
    log(`[${manager}] ${name} moved ${entry.version} -> ${version}.`);
  }
  recordInstalled(ledger, manager, name, { spec: entry.spec, version, pin: null, at: now() });
  return { manager, name, spec: entry.spec, status: 'installed', version, action: 'installed' };
}

/** Upgrade only unpinned packages; a pin is a deliberate version, not a stale one. */
export async function autoUpdatePackages(options: {
  manager: InstallManager;
  ledger: Ledger;
  runner: CommandRunner;
  log?: (line: string) => void;
  now?: () => string;
}): Promise<ProvisionOutcome[]> {
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => new Date().toISOString());
  const outcomes: ProvisionOutcome[] = [];

  for (const [name, entry] of Object.entries(options.ledger.packages[options.manager])) {
    if (entry.status !== 'installed') continue;
    const pin = normalizePin(entry.pin);
    if (pin) {
      log(`[${options.manager}] ${name} is pinned to ${pin}; auto-update skips it.`);
      continue;
    }
    outcomes.push(await upgradePackage({
      manager: options.manager,
      name,
      entry,
      ledger: options.ledger,
      runner: options.runner,
      log,
      now,
    }));
  }

  return outcomes;
}

export type ServerPackage = {
  /** The mcp.json server the package belongs to. */
  server: string;
  manager: InstallManager;
  spec: string;
  name: string;
  pin: string | null;
};

/**
 * The packages the configured MCP servers run.
 *
 * `npx` and `uvx` resolve a spec against a cache and never move an existing
 * copy forward, so a launcher server drifts behind its release on its own.
 * Reading mcp.json puts those servers on the same install-and-upgrade path as
 * a package added from Settings. A config that runs the installed binary
 * instead of the launcher carries no spec, so the bundled catalog entry with
 * the same server name supplies the package.
 */
export function serverPackages(
  servers: Record<string, McpServerEntry>,
  catalog: readonly CatalogEntry[] = bundledCatalog(),
): ServerPackage[] {
  const packages: ServerPackage[] = [];
  for (const [server, entry] of Object.entries(servers)) {
    if (entry.enabled === false || entry.disabled === true || !entry.command) continue;
    const direct = packageSpecFromEntry(entry);
    const known = direct ? null : catalog.find((candidate) => candidate.name === server && candidate.command);
    const pkg = direct ?? (known ? packageSpecFromEntry({ command: known.command, args: known.args }) : null);
    if (!pkg) continue;
    packages.push({
      server,
      manager: pkg.manager === 'npm' ? 'npm' : 'uv',
      spec: pkg.spec,
      name: pkg.name,
      pin: entry.pin ?? null,
    });
  }
  return packages;
}

function upgradeCommand(manager: InstallManager, parsed: ReturnType<typeof parsePackageSpec>): { command: string; args: string[] } {
  switch (manager) {
    case 'uv':
      return { command: 'uv', args: ['tool', 'upgrade', '-q', parsed.name] };
    case 'pip':
      return { command: 'uv', args: ['pip', 'install', '-q', '--system', '--break-system-packages', '--upgrade', parsed.name] };
    case 'npm':
      return { command: 'npm', args: ['install', '-g', '--no-fund', '--no-audit', `${parsed.name}@latest`] };
    case 'aqua':
      return { command: 'install-github-app', args: [parsed.raw] };
    case 'apt':
      return { command: 'apt-get', args: ['install', '-y', '-qq', '--only-upgrade', parsed.name] };
    case 'android':
      // `sdkmanager --install` on an installed component is its update: the
      // revision comes from the channel, exactly like a first install.
      return installCommand('android', parsed, null);
  }
}
