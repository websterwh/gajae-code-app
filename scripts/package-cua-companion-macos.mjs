import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('macOS DMGs must be packaged on macOS.');

const output = join('release', 'companion');
const universal = join(output, 'gajae-cua-companion-macos-universal');
const stage = join(output, 'macos-stage');
const app = join(stage, 'Gajae CUA Companion.app');
const executable = join(app, 'Contents', 'MacOS', 'gajae-cua-companion');
const dmg = join(output, 'gajae-cua-companion-macos-universal.dmg');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// x64 needs -baseline: Bun's default x64 build assumes AVX2, which crashes
// with an illegal-instruction panic on older/budget x64 CPUs (confirmed on
// an Intel MacBook Air). arm64 has no baseline variant.
for (const architecture of ['x64', 'arm64']) {
  const target = architecture === 'x64' ? 'bun-darwin-x64-baseline' : 'bun-darwin-arm64';
  const result = spawnSync('bun', [
    'build', '--compile', '--target', target, 'companion/cua-companion.mjs',
    '--outfile', join(output, `gajae-cua-companion-darwin-${architecture}`),
  ], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const merged = spawnSync('lipo', ['-create',
  join(output, 'gajae-cua-companion-darwin-x64'),
  join(output, 'gajae-cua-companion-darwin-arm64'),
  '-output', universal,
], { stdio: 'inherit' });
if (merged.status !== 0) process.exit(merged.status ?? 1);

await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
await cp(universal, executable);
await writeFile(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>Gajae CUA Companion</string><key>CFBundleExecutable</key><string>gajae-cua-companion</string><key>CFBundleIdentifier</key><string>app.gajae.cua-companion</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>Gajae CUA Pairing</string><key>CFBundleURLSchemes</key><array><string>gajae-cua</string></array></dict></array></dict></plist>`);
const packaged = spawnSync('hdiutil', [
  'create', '-size', '256m', '-volname', 'Gajae CUA Companion', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg,
], { stdio: 'inherit' });
if (packaged.status !== 0) process.exit(packaged.status ?? 1);
await rm(stage, { recursive: true, force: true });
await rm(universal, { force: true });
// Keep the raw per-architecture binaries alongside the DMG: a plain CLI
// binary runnable from a terminal is the current supported macOS artifact
// while the app bundle's own pairing/settings UI is still unbuilt.
