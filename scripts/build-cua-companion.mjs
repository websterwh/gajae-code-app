import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const target = process.argv[2];
const targets = target ? [target] : ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];
const output = join('release', 'companion');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const platform of targets) {
  const extension = platform.startsWith('windows-') ? '.exe' : '';
  const outfile = join(output, `gajae-cua-companion-${platform}${extension}`);
  const result = spawnSync('dist-native/bun', [
    'build', '--compile', '--target', `bun-${platform}`, 'companion/cua-companion.mjs', '--outfile', outfile,
  ], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (platform.startsWith('darwin-')) {
    const app = join(output, `Gajae CUA Companion-${platform}.app`);
    const macOs = join(app, 'Contents', 'MacOS');
    await mkdir(macOs, { recursive: true });
    await cp(outfile, join(macOs, 'gajae-cua-companion'));
    await writeFile(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleDisplayName</key><string>Gajae CUA Companion</string><key>CFBundleExecutable</key><string>gajae-cua-companion</string><key>CFBundleIdentifier</key><string>app.gajae.cua-companion</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>Gajae CUA Pairing</string><key>CFBundleURLSchemes</key><array><string>gajae-cua</string></array></dict></array></dict></plist>`);
    const archive = `gajae-cua-companion-${platform}.app.zip`;
    const zipped = spawnSync('zip', ['-qry', archive, `Gajae CUA Companion-${platform}.app`], { cwd: output, stdio: 'inherit' });
    if (zipped.status !== 0) process.exit(zipped.status ?? 1);
    await rm(app, { recursive: true, force: true });
  }
}
