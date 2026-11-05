import { mkdir, rm } from 'node:fs/promises';
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
}
