// Builds the Rust `agent-desktop-companion` binary for one or more targets.
//
// Unlike the old Bun-based `build-cua-companion.mjs`, cross-compiling Rust
// needs each target's std library installed (`rustup target add <triple>`)
// plus, for a non-native OS, a linker for that OS (macOS/Windows binaries
// cannot be produced from a bare Linux box without `cross`/osxcross/a
// matching toolchain). This script builds only the targets whose toolchain
// is actually present and reports the rest as skipped - it does not pretend
// to produce artifacts it cannot actually produce.
import { cp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const TARGETS = {
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', binaryName: 'agent-desktop-companion' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', binaryName: 'agent-desktop-companion' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', binaryName: 'agent-desktop-companion' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin', binaryName: 'agent-desktop-companion' },
  'windows-x64': { triple: 'x86_64-pc-windows-msvc', binaryName: 'agent-desktop-companion.exe' },
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(TARGETS);
for (const name of names) {
  if (!TARGETS[name]) throw new Error(`Unknown target "${name}". Known: ${Object.keys(TARGETS).join(', ')}`);
}

const crateDir = join('companion-rs');
const output = join('release', 'companion-rs');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

function hasRustup() {
  return spawnSync('rustup', ['--version'], { stdio: 'ignore' }).status === 0;
}

function installedTargets() {
  if (!hasRustup()) return new Set();
  const result = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
  if (result.status !== 0) return new Set();
  return new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean));
}

const nativeTriple = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout
  .split('\n').find((line) => line.startsWith('host: '))?.slice('host: '.length).trim();
const installed = installedTargets();

const built = [];
const skipped = [];
for (const name of names) {
  const { triple, binaryName } = TARGETS[name];
  const isNative = triple === nativeTriple;
  if (!isNative && !installed.has(triple)) {
    skipped.push({ name, reason: `rust target "${triple}" is not installed (run: rustup target add ${triple}); cross-compiling macOS/Windows from a non-matching host also needs a matching linker/toolchain, which this script does not install` });
    continue;
  }
  const args = ['build', '--release'];
  if (!isNative) args.push('--target', triple);
  const result = spawnSync('cargo', args, { cwd: crateDir, stdio: 'inherit' });
  if (result.status !== 0) {
    skipped.push({ name, reason: `cargo build failed (exit ${result.status})` });
    continue;
  }
  const builtPath = isNative
    ? join(crateDir, 'target', 'release', binaryName)
    : join(crateDir, 'target', triple, 'release', binaryName);
  const destName = `gajae-agent-desktop-companion-${name}${name.startsWith('windows') ? '.exe' : ''}`;
  await cp(builtPath, join(output, destName));
  built.push(destName);
}

console.log(`Built: ${built.length ? built.join(', ') : '(none)'}`);
if (skipped.length) {
  console.log('Skipped:');
  for (const { name, reason } of skipped) console.log(`  - ${name}: ${reason}`);
}
if (!built.length) process.exit(1);
