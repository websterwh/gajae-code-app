import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  adoptAgentInstalledPackagesFromTranscript,
  adoptAgentPackageInstalls,
  installCommandsFromTranscript,
  parseInstallCommands,
} from './agent-packages.service.js';

test('apt, pip, uv and global npm installs are read; local and file-based ones are not', () => {
  const installs = parseInstallCommands([
    'sudo apt-get update && sudo apt-get install -y --no-install-recommends build-essential ffmpeg',
    'pip install "requests==2.32.3" rich',
    'python3 -m pip install --upgrade httpx',
    'uv tool install ruff',
    'uv pip install --system --break-system-packages pymobiledevice3',
    'npm install -g @scope/tool some-pkg',
    'npm install left-pad',
    'pip install -r requirements.txt',
    'pip install git+https://github.com/example/repo.git',
    'pip install ./local-checkout',
  ]);

  assert.deepEqual(installs, [
    { manager: 'apt', name: 'build-essential', spec: 'build-essential' },
    { manager: 'apt', name: 'ffmpeg', spec: 'ffmpeg' },
    { manager: 'pip', name: 'requests', spec: 'requests==2.32.3' },
    { manager: 'pip', name: 'rich', spec: 'rich' },
    { manager: 'pip', name: 'httpx', spec: 'httpx' },
    { manager: 'uv', name: 'ruff', spec: 'ruff' },
    { manager: 'pip', name: 'pymobiledevice3', spec: 'pymobiledevice3' },
    { manager: 'npm', name: '@scope/tool', spec: '@scope/tool' },
    { manager: 'npm', name: 'some-pkg', spec: 'some-pkg' },
  ]);
});

test('quoted commands and shell operators do not confuse the parser', () => {
  assert.deepEqual(parseInstallCommands([
    'cd /tmp && apt-get install -y "libssl-dev" > /dev/null 2>&1; apt-get install -y jq # done',
    'echo "apt-get install fake" && pip3 install --no-cache-dir pyyaml',
  ]), [
    { manager: 'apt', name: 'libssl-dev', spec: 'libssl-dev' },
    { manager: 'apt', name: 'jq', spec: 'jq' },
    { manager: 'pip', name: 'pyyaml', spec: 'pyyaml' },
  ]);
});

test('a transcript yields only the bash commands its model issued', () => {
  const entries = [
    { type: 'session', id: 's' },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'text', text: 'installing' },
      { type: 'toolCall', name: 'bash', arguments: { command: 'apt-get install -y jq' } },
      { type: 'toolCall', name: 'read', arguments: { path: '/tmp/x' } },
    ] } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'toolCall', name: 'bash', arguments: JSON.stringify({ command: 'pip install pyyaml' }) },
    ] } },
    'not json',
  ].map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n');

  assert.deepEqual(installCommandsFromTranscript(entries), ['apt-get install -y jq', 'pip install pyyaml']);
});

test('only installs that are present become desired and ledger entries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-packages-'));
  const desiredFile = path.join(directory, 'packages.json');
  const ledgerFile = path.join(directory, 'provision-ledger.json');
  try {
    const installs = parseInstallCommands(['apt-get install -y jq ripgrep', 'pip install requests']);
    const adopted = await adoptAgentPackageInstalls(installs, {
      desiredFile,
      ledgerFile,
      now: () => '2026-11-25T00:00:00.000Z',
      verify: async (install) => ({ installed: install.name !== 'ripgrep', version: install.name === 'jq' ? '1.6' : null }),
    });
    assert.deepEqual(adopted.map((install) => install.name), ['jq', 'requests']);

    const desired = JSON.parse(await readFile(desiredFile, 'utf8')) as { packages: Record<string, Record<string, { spec: string; addedAt: string }>> };
    assert.equal(desired.packages.apt.jq.spec, 'jq');
    assert.equal(desired.packages.apt.jq.addedAt, '2026-11-25T00:00:00.000Z');
    assert.equal(desired.packages.pip.requests.spec, 'requests');
    assert.equal(desired.packages.apt.ripgrep, undefined, 'a package that is not installed must not be replayed on boot');

    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) as { packages: Record<string, Record<string, { status: string; version: string | null }>> };
    assert.equal(ledger.packages.apt.jq.status, 'installed');
    assert.equal(ledger.packages.apt.jq.version, '1.6');
    assert.equal(ledger.packages.pip.requests.status, 'installed');

    // A later turn re-sends the same history; already-adopted packages must
    // not be verified or written again. The one that never installed may be
    // retried, since the agent could have fixed it since.
    const verified: string[] = [];
    const again = await adoptAgentPackageInstalls(installs, {
      desiredFile,
      ledgerFile,
      verify: async (install) => { verified.push(install.name); return { installed: false, version: null }; },
    });
    assert.deepEqual(again, []);
    assert.deepEqual(verified, ['ripgrep']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the post-turn entry point adopts from a transcript file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-packages-transcript-'));
  const transcript = path.join(directory, 'session.jsonl');
  try {
    await writeFile(transcript, JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: [
        { type: 'toolCall', name: 'bash', arguments: { command: 'uv pip install yt-dlp' } },
      ] },
    }) + '\n');
    const adopted = await adoptAgentInstalledPackagesFromTranscript(transcript, {
      desiredFile: path.join(directory, 'packages.json'),
      ledgerFile: path.join(directory, 'ledger.json'),
      verify: async () => ({ installed: true, version: '2026.11.1' }),
    });
    assert.deepEqual(adopted, [{ manager: 'pip', name: 'yt-dlp', spec: 'yt-dlp' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
