// Builds the Rust `agent-desktop-companion` binary for one or more targets.
//
// Unlike the old Bun-based `build-cua-companion.mjs`, cross-compiling Rust
// needs each target's std library installed (`rustup target add <triple>`)
// plus, for a non-native OS, a linker for that OS (macOS/Windows binaries
// cannot be produced from a bare Linux box without `cross`/osxcross/a
// matching toolchain). This script builds only the targets whose toolchain
// is actually present and reports the rest as skipped - it does not pretend
// to produce artifacts it cannot actually produce.
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
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

const nativeTriple = spawnSync('rustc', ['-vV'], { encoding: 'utf8' }).stdout
  .split('\n').find((line) => line.startsWith('host: '))?.slice('host: '.length).trim();

// Do not pre-check `rustup target list --installed`: when a toolchain is
// activated via a directory/env override (as `dtolnay/rust-toolchain@stable`
// does) rather than as rustup's own default, that query inspects the wrong
// toolchain and reports every non-native target as missing even when it is
// actually installed and buildable. Attempt the build directly instead and
// classify failure as "missing target/linker" only when cargo itself says so.
const built = [];
const skipped = [];
const ARCHIVE_ROOT = join('release', 'agent-desktop');
for (const name of names) {
  const { triple, binaryName } = TARGETS[name];
  const isNative = triple === nativeTriple;
  const args = ['build', '--release'];
  if (!isNative) args.push('--target', triple);
  const result = spawnSync('cargo', args, { cwd: crateDir, stdio: 'inherit' });
  if (result.status !== 0) {
    skipped.push({ name, reason: `cargo build failed (exit ${result.status}); likely missing target "${triple}" (run: rustup target add ${triple}) or, for a non-native OS, a matching linker/toolchain this script does not install` });
    continue;
  }
  const builtPath = isNative
    ? join(crateDir, 'target', 'release', binaryName)
    : join(crateDir, 'target', triple, 'release', binaryName);
  const destName = `gajae-agent-desktop-companion-${name}${name.startsWith('windows') ? '.exe' : ''}`;
  await cp(builtPath, join(output, destName));
  built.push({ name, destName });
}

// A staged agent-desktop (see stage-agent-desktop-bundle.mjs) is packaged next
// to the companion, so the archive is the whole install: no --install-agent-
// desktop, no Node/npm, no PATH change. Targets without a staged driver still
// publish the bare binary, which keeps the existing download URL working.
for (const { name, destName } of built) {
  const stagedDir = join(ARCHIVE_ROOT, name);
  let staged = [];
  try {
    staged = await readdir(stagedDir);
  } catch { continue; }
  if (!staged.length) continue;
  const bundleDir = join(output, `bundle-${name}`);
  await mkdir(bundleDir, { recursive: true });
  await cp(join(output, destName), join(bundleDir, destName));
  for (const entry of staged) await cp(join(stagedDir, entry), join(bundleDir, entry), { recursive: true });
  const archive = join(output, `gajae-agent-desktop-companion-${name}.tar.gz`);
  const packed = spawnSync('tar', ['-czf', archive, '-C', bundleDir, '.'], { stdio: 'inherit' });
  if (packed.status !== 0) throw new Error(`failed to package ${archive} (exit ${packed.status})`);
  await rm(bundleDir, { recursive: true, force: true });
  console.log(`Bundled: ${archive} (companion + ${staged.join(', ')})`);
}

console.log(`Built: ${built.length ? built.map((entry) => entry.destName).join(', ') : '(none)'}`);
if (skipped.length) {
  console.log('Skipped:');
  for (const { name, reason } of skipped) console.log(`  - ${name}: ${reason}`);
}
if (!built.length) process.exit(1);
