#!/usr/bin/env node
/**
 * Outbound-only CUA Driver companion. It deliberately exposes no shell,
 * filesystem, browser, clipboard, or generic MCP forwarding surface.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
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

// A portable install deliberately skips the shell PATH (that's the point of
// --prefix/--no-modify-path), so look in the default and last-used portable
// locations before falling back to PATH. Remembering the last install
// location means a later run doesn't need --portable-dir repeated.
function resolveDriverPath() {
  if (process.env.CUA_DRIVER_PATH) return process.env.CUA_DRIVER_PATH;
  const exe = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
  const candidates = [
    args['portable-dir'] ? join(args['portable-dir'], 'bin', exe) : null,
    join(homedir(), '.gajae-cua', 'bin', exe),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return exe;
}

function run(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

const color = { dim: '[2m', green: '[32m', yellow: '[33m', red: '[31m', reset: '[0m' };

// CUA's installer prints a lot of telemetry-disclosure and onboarding text
// that is noise for this one-shot driver-only install. Keep the few lines
// that matter (progress, warnings, the final install line, errors) visible
// and in color; push the rest to --verbose-install only.
const INSTALL_SIGNAL = /^(==>|warning:|error:|note:|Installed |cua-driver-rs .* installed)/u;
function runInstaller(command, commandArgs) {
  const verbose = args['verbose-install'] === 'true';
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    if (!verbose) {
      let buffer = '';
      const onChunk = chunk => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf('\n'); if (index < 0) break;
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!INSTALL_SIGNAL.test(line)) continue;
          const tint = /^error:/u.test(line) ? color.red : /^warning:/u.test(line) ? color.yellow
            : /^(Installed |cua-driver-rs .* installed)/u.test(line) ? color.green : color.dim;
          console.error(`${tint}${line}${color.reset}`);
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
    }
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

async function installDriver(mode) {
  if (mode !== 'portable' && mode !== 'system') throw new Error('--install-driver must be portable or system.');
  const portable = mode === 'portable';
  // No space in the default prefix: a space here forces every later shell
  // invocation (install.sh args, PATH export snippets, saved state) to get
  // quoting right, and it's an easy way to break a copy-pasted command.
  const prefix = args['portable-dir'] ?? join(homedir(), '.gajae-cua');
  // CUA's installer always verifies sha256 regardless of this flag; strict
  // --require-signature additionally needs minisign/cosign on the machine,
  // which most machines don't have, and otherwise hard-fails with no
  // fallback. Require it only when the caller explicitly opts in.
  const requireSignature = args['require-signature'] === 'true';
  if (process.platform === 'win32') {
    const options = `${portable ? ` -Prefix '${prefix.replace(/'/gu, "''")}' -NoPathUpdate` : ''}${requireSignature ? ' -RequireSignature' : ''}`;
    console.error(`${color.dim}[info] Installing CUA Driver (${mode})...${color.reset}`);
    await runInstaller('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ([scriptblock]::Create((irm https://cua.ai/install.ps1))) -Only cua-driver -NoOnboarding${options}`]);
    console.error(`${color.green}[info] CUA Driver installed.${color.reset}`);
    return;
  }
  // CUA publishes this installer and its release manifest. The documented
  // options keep portable installations entirely below the selected prefix.
  const options = [
    '--only', 'cua-driver', '--no-onboarding',
    ...(portable ? ['--prefix', prefix, '--no-modify-path'] : []),
    ...(requireSignature ? ['--require-signature'] : []),
    '--yes',
  ];
  console.error(`${color.dim}[info] Installing CUA Driver (${mode}) to ${portable ? prefix : 'the system default location'}...${color.reset}`);
  await runInstaller('/bin/bash', ['-c', 'curl -fsSL https://cua.ai/install.sh | sh -s -- "$@"', 'gajae-cua-installer', ...options]);
  console.error(`${color.green}[info] CUA Driver installed. Run with --server=... --pair=... to connect; the companion locates it automatically.${color.reset}`);
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
  try {
    await installDriver(args['install-driver']);
    process.exit(0);
  } catch (cause) {
    console.error(`[error] ${cause instanceof Error ? cause.message : 'CUA Driver installation failed.'}`);
    console.error('[hint] If this fails with a signature error, retry with --require-signature=true once minisign or cosign is installed, or omit it to rely on sha256 verification alone.');
    process.exit(1);
  }
}
if (args['register-protocol']) {
  try {
    await registerProtocol();
    process.exit(0);
  } catch (cause) {
    console.error(`[error] ${cause instanceof Error ? cause.message : 'Protocol registration failed.'}`);
    process.exit(1);
  }
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
  // `spawn` for a missing executable never throws synchronously: it returns
  // an object immediately and only emits an async 'error' (ENOENT) shortly
  // after. Until that settles (or the driver proves itself by replying),
  // treat readiness as unknown rather than assuming success.
  let child;
  let launchError;
  let confirmed = false;
  try {
    child = spawn(resolveDriverPath(), ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (cause) {
    launchError = cause instanceof Error ? cause.message : 'CUA Driver failed to start';
  }
  let sequence = 0; const pending = new Map();
  let buffer = '';
  if (child) {
    // A listener here is required: Node re-throws an unhandled 'error' event
    // as a process-crashing exception, which is what killed the process when
    // cua-driver was missing.
    child.on('error', cause => {
      launchError = cause instanceof Error ? cause.message : 'CUA Driver failed to start';
      for (const call of pending.values()) call.reject(new Error(launchError));
      pending.clear();
    });
    child.on('exit', code => {
      if (code !== 0 && !launchError) launchError = `CUA Driver exited with code ${code}`;
    });
    child.stdout.on('data', chunk => {
      confirmed = true;
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
  }
  return {
    get ready() { return Boolean(child) && !launchError; },
    get confirmed() { return confirmed; },
    call(tool, parameters) {
      if (!child || launchError) {
        return Promise.reject(new Error(launchError ?? 'CUA Driver is not installed. Run with --install-driver=portable or --install-driver=system first.'));
      }
      const id = String(++sequence);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: parameters } })}\n`);
      });
    },
    close: () => child?.kill('SIGTERM'),
  };
}

// Started lazily, after the usage/validation checks above, so a missing CUA
// Driver install never crashes the whole process before pairing can even run.
const driver = startDriver();
// spawn()'s ENOENT surfaces asynchronously; give it a tick before reporting.
setTimeout(() => {
  if (!driver.ready) {
    console.error('[warn] CUA Driver is not available yet; pairing and connection will proceed, but tool calls will fail.');
    console.error('[warn] Install it with: gajae-cua-companion --install-driver=portable   (or --install-driver=system)');
  }
}, 250);
let state = await loadState();
const completed = new Set();
function readiness() {
  return { type: 'readiness', protocolVersion: VERSION, readiness: {
    driverVersion: process.env.CUA_DRIVER_VERSION, schemaSupported: driver.ready, daemon: driver.ready ? 'running' : 'stopped',
    safeTools: [...SAFE_TOOLS], deviceName: args.name ?? hostname(), os: `${platform()} ${process.arch}`,
  }};
}
function connect() {
  console.error(`[info] Connecting to ${server} ...`);
  let confirmedAuth = false;
  const socket = new WebSocket(url);
  socket.on('open', () => {
    console.error('[info] Connected. Authenticating...');
    socket.send(JSON.stringify({
      type: 'hello', protocolVersion: VERSION,
      ...(state ? { deviceId: state.deviceId, credential: state.credential } : { pairingToken, deviceName: args.name ?? hostname(), os: `${platform()} ${process.arch}` }),
    }));
  });
  socket.on('message', async raw => {
    let message; try { message = JSON.parse(raw.toString()); } catch { socket.close(1008, 'invalid JSON'); return; }
    if (message.protocolVersion !== VERSION) { socket.close(1008, 'unsupported protocol'); return; }
    if (message.type === 'paired') {
      state = { deviceId: message.deviceId, credential: message.credential };
      await saveState(state);
      console.error('[info] Paired and connected. This device is now available to the server.');
    }
    if (message.type === 'pong' && !confirmedAuth) { confirmedAuth = true; console.error('[info] Connected and authenticated with the server.'); }
    if (message.type === 'pong' || message.type === 'paired') socket.send(JSON.stringify(readiness()));
    if (message.type === 'disconnect') { console.error(`[info] Server disconnected this device: ${message.reason}`); socket.close(4003, message.reason); }
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
  socket.on('close', (code, reasonBuffer) => {
    const reason = reasonBuffer?.toString() || '';
    if (code === 1008) console.error(`[error] Server rejected this connection${reason ? `: ${reason}` : '.'} Check the pairing token or server URL.`);
    else console.error(`[info] Disconnected (code ${code}${reason ? `: ${reason}` : ''}). Reconnecting in 2s...`);
    setTimeout(connect, 2_000);
  });
  socket.on('error', cause => console.error(`[error] Connection error: ${cause instanceof Error ? cause.message : cause}`));
}
process.on('SIGINT', () => { driver.close(); process.exit(0); });
connect();
