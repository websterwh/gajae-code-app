#!/usr/bin/env node
/**
 * Outbound-only CUA Driver companion. It deliberately exposes no shell,
 * filesystem, browser, clipboard, or generic MCP forwarding surface.
 */
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const VERSION = 1;
const SAFE_TOOLS = new Set(['start_session', 'end_session', 'list_apps', 'list_windows', 'get_window_state',
  'get_accessibility_tree', 'launch_app', 'set_window_frame', 'move_cursor', 'click', 'type_text',
  'press_key', 'hotkey', 'scroll', 'invoke_menu']);
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const deepLink = process.argv.slice(2).find(value => value.startsWith('gajae-cua://'));
if (deepLink) {
  const link = new URL(deepLink);
  if (link.hostname !== 'pair') throw new Error('Unsupported Gajae CUA link.');
  args.server = link.searchParams.get('server') ?? '';
  args.pair = link.searchParams.get('token') ?? '';
}
const server = args.server;
const pairingToken = args.pair;
const statePath = args.state ?? join(homedir(), '.config', 'gajae-cua-companion', 'device.json');

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function installDriver(mode) {
  if (mode !== 'portable' && mode !== 'system') throw new Error('--install-driver must be portable or system.');
  const portable = mode === 'portable';
  const prefix = args['portable-dir'] ?? join(homedir(), 'Gajae CUA');
  if (process.platform === 'win32') {
    const options = portable
      ? ` -Prefix '${prefix.replace(/'/gu, "''")}' -NoPathUpdate -RequireSignature`
      : ' -RequireSignature';
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ([scriptblock]::Create((irm https://cua.ai/driver/install.ps1)))${options}`]);
    return;
  }
  // CUA publishes this installer and its release manifest. The documented
  // options keep portable installations entirely below the selected prefix.
  const options = portable
    ? ['--only', 'cua-driver', '--prefix', prefix, '--no-modify-path', '--require-signature', '--yes']
    : ['--only', 'cua-driver', '--require-signature', '--yes'];
  await run('/bin/bash', ['-c', 'curl -fsSL https://cua.ai/install.sh | sh -s -- "$@"', 'gajae-cua-installer', ...options]);
}

async function registerProtocol() {
  const executable = process.execPath;
  if (process.platform === 'linux') {
    const applications = join(homedir(), '.local', 'share', 'applications');
    await mkdir(applications, { recursive: true, mode: 0o700 });
    const desktop = join(applications, 'gajae-cua-companion.desktop');
    await writeFile(desktop, `[Desktop Entry]\nType=Application\nName=Gajae CUA Companion\nExec=${executable} %u\nMimeType=x-scheme-handler/gajae-cua;\nNoDisplay=true\n`, { mode: 0o600 });
    await run('xdg-mime', ['default', 'gajae-cua-companion.desktop', 'x-scheme-handler/gajae-cua']);
    return;
  }
  if (process.platform === 'win32') {
    await run('reg.exe', ['add', 'HKCU\\Software\\Classes\\gajae-cua', '/ve', '/d', 'URL:Gajae CUA Companion', '/f']);
    await run('reg.exe', ['add', 'HKCU\\Software\\Classes\\gajae-cua', '/v', 'URL Protocol', '/d', '', '/f']);
    await run('reg.exe', ['add', 'HKCU\\Software\\Classes\\gajae-cua\\shell\\open\\command', '/ve', '/d', `"${executable}" "%1"`, '/f']);
    return;
  }
  if (process.platform === 'darwin') {
    throw new Error('On macOS, open the released Gajae CUA Companion.app once to register gajae-cua links.');
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

if (args['install-driver']) {
  await installDriver(args['install-driver']);
  process.exit(0);
}
if (args['register-protocol']) {
  await registerProtocol();
  process.exit(0);
}
if (!server) throw new Error('Usage: gajae-cua-companion --server=wss://gajae.example/remote-cua --pair=TOKEN');
const url = new URL(server);
if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) {
  throw new Error('The companion requires wss://; ws:// is limited to localhost development.');
}

async function loadState() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return null; }
}
async function saveState(value) {
  await mkdir(join(statePath, '..'), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(value), { mode: 0o600 });
  await chmod(statePath, 0o600);
}
function allowed(tool, value) {
  if (!SAFE_TOOLS.has(tool) || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = ['click', 'type_text', 'press_key', 'hotkey', 'scroll', 'invoke_menu'].includes(tool);
  if (!input) return true;
  return value.delivery_mode !== 'foreground' && value.scope !== 'desktop'
    && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0;
}
function startDriver() {
  const child = spawn(process.env.CUA_DRIVER_PATH ?? 'cua-driver', ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0; const pending = new Map();
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      try {
        const message = JSON.parse(line); const call = pending.get(String(message.id));
        if (!call) continue; pending.delete(String(message.id));
        message.error ? call.reject(new Error(message.error.message ?? 'CUA Driver error')) : call.resolve(message.result);
      } catch { /* malformed driver output cannot become a capability */ }
    }
  });
  return {
    call(tool, parameters) {
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: parameters } })}\n`);
      });
    },
    close: () => child.kill('SIGTERM'),
  };
}

const driver = startDriver();
let state = await loadState();
const completed = new Set();
function readiness() {
  return { type: 'readiness', protocolVersion: VERSION, readiness: {
    driverVersion: process.env.CUA_DRIVER_VERSION, schemaSupported: true, daemon: 'unknown',
    safeTools: [...SAFE_TOOLS], deviceName: args.name ?? hostname(), os: `${platform()} ${process.arch}`,
  }};
}
function connect() {
  const socket = new WebSocket(url);
  socket.on('open', () => socket.send(JSON.stringify({
    type: 'hello', protocolVersion: VERSION,
    ...(state ? { deviceId: state.deviceId, credential: state.credential } : { pairingToken, deviceName: args.name ?? hostname(), os: `${platform()} ${process.arch}` }),
  })));
  socket.on('message', async raw => {
    let message; try { message = JSON.parse(raw.toString()); } catch { socket.close(1008, 'invalid JSON'); return; }
    if (message.protocolVersion !== VERSION) { socket.close(1008, 'unsupported protocol'); return; }
    if (message.type === 'paired') { state = { deviceId: message.deviceId, credential: message.credential }; await saveState(state); }
    if (message.type === 'pong' || message.type === 'paired') socket.send(JSON.stringify(readiness()));
    if (message.type === 'disconnect') socket.close(4003, message.reason);
    if (message.type !== 'computer.request') return;
    const error = !state || message.deviceId !== state.deviceId ? 'device ID mismatch'
      : completed.has(message.requestId) ? 'duplicate request ID'
        : Date.now() >= message.deadline ? 'expired deadline'
          : !allowed(message.tool, message.arguments) ? 'CUA policy denied this request' : null;
    completed.add(message.requestId);
    try {
      const result = error ? undefined : await driver.call(message.tool, message.arguments);
      socket.send(JSON.stringify({ type: 'computer.result', protocolVersion: VERSION, requestId: message.requestId, deviceId: message.deviceId, ...(error ? { error } : { result }) }));
    } catch (cause) {
      socket.send(JSON.stringify({ type: 'computer.result', protocolVersion: VERSION, requestId: message.requestId, deviceId: message.deviceId, error: cause instanceof Error ? cause.message : 'CUA Driver failed' }));
    }
  });
  socket.on('close', () => setTimeout(connect, 2_000));
  socket.on('error', () => {});
}
process.on('SIGINT', () => { driver.close(); process.exit(0); });
connect();
