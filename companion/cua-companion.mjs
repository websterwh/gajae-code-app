#!/usr/bin/env node
/**
 * Outbound-only CUA Driver companion. It deliberately exposes no shell,
 * filesystem, browser, clipboard, or generic MCP forwarding surface.
 */

// Bun's JIT emits AVX2 instructions on macOS x64 regardless of a -baseline
// compile target: -baseline only gates ahead-of-time-compiled code, and this
// is JIT-emitted at runtime once WebSocket/networking code paths tier up, so
// it crashes with an illegal-instruction panic on any Mac without AVX2
// (confirmed on an Intel MacBook Air; see Bun's own
// scripts/verify-baseline-static/CLAUDE.md, which documents JIT-emitted code
// as explicitly out of scope of its baseline verifier). There is no AVX
// feature flag reachable from JS, so this disables the JIT unconditionally
// for this exact combination - a compiled standalone executable running on
// macOS x64 - rather than gambling on CPUID detection; the cost is a slower
// start for a short-lived process that is not otherwise CPU-bound.
if (process.versions.bun && process.platform === 'darwin' && process.arch === 'x64' && !process.env.BUN_JSC_useJIT) {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, process.argv.slice(2), {
    stdio: 'inherit',
    env: { ...process.env, BUN_JSC_useJIT: '0' },
  });
  process.exit(result.status ?? 1);
}

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
// Node/Bun's TLS stack does not consult the OS/browser trust store (unlike
// Safari/Chrome), so a locally-signed cert that's trusted system-wide still
// fails verification here unless its CA is handed to us explicitly.
const caCertPath = args['ca-cert'] ?? process.env.NODE_EXTRA_CA_CERTS;

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
// Routine status goes to stdout; only warnings/errors go to stderr. Many
// terminals render all stderr output in red/alarming styling by default,
// which made ordinary "Connected"/"Status" lines look like failures even
// though they carried no color codes of their own.
function log(message) { console.log(message); }

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
    log(`${color.dim}[info] Installing CUA Driver (${mode})...${color.reset}`);
    await runInstaller('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `& ([scriptblock]::Create((irm https://cua.ai/install.ps1))) -Only cua-driver -NoOnboarding${options}`]);
    log(`${color.green}[info] CUA Driver installed.${color.reset}`);
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
  log(`${color.dim}[info] Installing CUA Driver (${mode}) to ${portable ? prefix : 'the system default location'}...${color.reset}`);
  await runInstaller('/bin/bash', ['-c', 'curl -fsSL https://cua.ai/install.sh | sh -s -- "$@"', 'gajae-cua-installer', ...options]);
  log(`${color.green}[info] CUA Driver installed. Run with --server=... --pair=... to connect; the companion locates it automatically.${color.reset}`);
}

// macOS gates CUA Driver's Accessibility/Screen Recording access through
// TCC, and the driver itself cannot self-grant: it has to start under its
// own exact installed path so macOS attributes the prompt to that specific
// binary, and the user has to flip each toggle on in System Settings
// ("Open System Settings" alone does not grant anything). `cua-driver
// permissions grant` drives that flow; this just runs it from the companion
// so the user does not have to find/install cua-driver's own CLI separately.
// Windows/Linux CUA Driver builds do not have an equivalent permission gate
// yet (see companion/PLANNED-FEATURES.md).
async function grantPermissions() {
  if (process.platform !== 'darwin') {
    throw new Error(`--grant-permissions is only implemented for macOS today; see companion/PLANNED-FEATURES.md for the planned ${process.platform} equivalent.`);
  }
  const executable = resolveDriverPath();
  log(`${color.dim}[info] Requesting macOS Accessibility and Screen Recording permission for CUA Driver...${color.reset}`);
  // `cua-driver permissions grant` itself only triggers the two System
  // Settings prompts and returns - it does not wait for the user to act on
  // them, and `permissions status` right after would just report whatever
  // was true before the prompts are answered. So this exits as soon as the
  // grant command itself completes, rather than chaining a status check the
  // user has to wait on for a decision that is theirs to make in System
  // Settings. They get the exact follow-up command to re-check afterward.
  await run(executable, ['permissions', 'grant']);
  log(`${color.green}[info] If System Settings opened, switch on both Accessibility and Screen Recording for CuaDriver, then run "${executable} permissions status" to confirm. macOS only re-reads the grant after CUA Driver relaunches.${color.reset}`);
}


// Removes everything this companion owns: CUA's own driver (portable and/or
// system install, via the canonical uninstaller CUA itself publishes - see
// https://cua.ai/driver/uninstall.sh and uninstall.ps1) plus the companion's
// own pairing state and portable install prefix. Deliberately does NOT touch
// macOS TCC grants (Accessibility/Screen Recording) by default: CUA's own
// uninstaller keeps those too, so a reinstall of the same signed app needs no
// new approval. Pass --reset-permissions to also revoke them on macOS.
async function uninstallDriver() {
  const resetPermissions = args['reset-permissions'] === 'true';
  if (process.platform === 'win32') {
    log(`${color.dim}[info] Uninstalling CUA Driver...${color.reset}`);
    await runInstaller('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "$env:CUA_DRIVER_RS_UNINSTALL_FORCE='1'; & ([scriptblock]::Create((irm https://cua.ai/driver/uninstall.ps1)))"]);
  } else {
    const forwarded = resetPermissions ? ['--', '--reset-permissions'] : [];
    log(`${color.dim}[info] Uninstalling CUA Driver...${color.reset}`);
    await runInstaller('/bin/bash', ['-c', 'curl -fsSL https://cua.ai/driver/uninstall.sh | sh -s -- "$@"', 'gajae-cua-uninstaller', ...forwarded]);
  }
  // CUA's uninstaller removes its own default (system) install location; a
  // --portable-dir install (this companion's default ~/.gajae-cua, or a
  // caller-supplied one) lives outside that and is never touched by it, so
  // remove it here directly.
  const portableDir = args['portable-dir'] ?? join(homedir(), '.gajae-cua');
  log(`${color.dim}[info] Removing portable CUA Driver install at ${portableDir} (if present)...${color.reset}`);
  await rm(portableDir, { recursive: true, force: true });
  log(`${color.dim}[info] Removing companion pairing state at ${statePath}...${color.reset}`);
  await rm(statePath, { force: true });
  log(`${color.green}[info] CUA Driver and companion state removed.${resetPermissions ? '' : ' macOS Accessibility/Screen Recording grants for CuaDriver were left in place; rerun with --reset-permissions=true to revoke them too.'}${color.reset}`);
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
if (Object.hasOwn(args, 'register-protocol')) {
  try {
    await registerProtocol();
    process.exit(0);
  } catch (cause) {
    console.error(`[error] ${cause instanceof Error ? cause.message : 'Protocol registration failed.'}`);
    process.exit(1);
  }
}
if (Object.hasOwn(args, 'grant-permissions')) {
  try {
    await grantPermissions();
    process.exit(0);
  } catch (cause) {
    console.error(`[error] ${cause instanceof Error ? cause.message : 'Requesting permissions failed.'}`);
    process.exit(1);
  }
}
if (Object.hasOwn(args, 'uninstall')) {
  try {
    await uninstallDriver();
    process.exit(0);
  } catch (cause) {
    console.error(`[error] ${cause instanceof Error ? cause.message : 'Uninstall failed.'}`);
    process.exit(1);
  }
}
if (!server) throw new Error('Usage: gajae-cua-companion --server=gjc.example.com --pair=TOKEN');
// Accept a bare domain (the common case) as well as a full URL, so a user
// never has to know this needs wss:// and /remote-cua: both get filled in
// unless the caller already supplied them (e.g. a non-default port, or an
// explicit ws:// for local development).
const url = /^wss?:\/\//iu.test(server) ? new URL(server) : new URL(`wss://${server}`);
if (url.pathname === '/' || url.pathname === '') url.pathname = '/remote-cua';
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
  // cua-driver's MCP server rejects any tools/call made before the standard
  // MCP handshake (initialize, then notifications/initialized) completes,
  // with "Missing required per-request MCP metadata". This mirrors exactly
  // what the app's own in-process CuaDriverClient does for the local path
  // (see server/modules/automation/cua-client.ts), so the remote companion
  // path performs the same two-step handshake instead of going straight to
  // tools/call.
  let initializing;
  function request(method, params) {
    if (!child || launchError) {
      return Promise.reject(new Error(launchError ?? 'CUA Driver is not installed. Run with --install-driver=portable or --install-driver=system first.'));
    }
    const id = String(++sequence);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  function notify(method, params) {
    if (!child || launchError) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  function initialize() {
    if (initializing) return initializing;
    initializing = request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'gajae-cua-companion', version: String(VERSION) },
    }).then(() => { notify('notifications/initialized', {}); })
      .catch(cause => { initializing = undefined; throw cause; });
    return initializing;
  }
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
    async call(tool, parameters) {
      if (!child || launchError) {
        return Promise.reject(new Error(launchError ?? 'CUA Driver is not installed. Run with --install-driver=portable or --install-driver=system first.'));
      }
      await initialize();
      return request('tools/call', { name: tool, arguments: parameters });
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
    if (process.platform === 'darwin') {
      console.error('[warn] Once installed, run: gajae-cua-companion --grant-permissions   to request macOS Accessibility and Screen Recording access.');
    }
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
let retryCount = 0;
function connect() {
  log(`[info] Connecting to ${url} ...`);
  let confirmedAuth = false;
  let lastError;
  let httpStatus;
  const socket = new WebSocket(url, caCertPath ? { ca: readFileSync(caCertPath) } : undefined);
  // Reverse proxies and auth middleware (OIDC, basic auth, etc.) in front of
  // the server reject the upgrade at the HTTP layer before ws ever completes
  // the handshake; that response is only visible on 'unexpected-response',
  // not on 'close'/'error'.
  socket.on('unexpected-response', (_request, response) => {
    httpStatus = response.statusCode;
    response.resume();
    // ws does not close the connection on its own here; without this the
    // process hangs forever instead of reaching 'close' or giving up.
    socket.terminate();
  });
  socket.on('open', () => {
    log('[info] Connected. Authenticating...');
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
      retryCount = 0;
      log('[info] Paired and connected. This device is now available to the server.');
    }
    if (message.type === 'pong' && !confirmedAuth) { confirmedAuth = true; retryCount = 0; log('[info] Connected and authenticated with the server.'); }
    if (message.type === 'pong' || message.type === 'paired') {
      const current = readiness();
      socket.send(JSON.stringify(current));
      const r = current.readiness;
      const driverState = r.schemaSupported ? `${color.green}CUA Driver ready${r.driverVersion ? ` (v${r.driverVersion})` : ''}${color.reset}`
        : `${color.yellow}CUA Driver not available - tool calls will fail${color.reset}`;
      log(`[info] Status: device "${r.deviceName}" (${r.os}) - ${driverState} - ${r.safeTools.length} tools reviewed.`);
    }
    if (message.type === 'disconnect') { log(`[info] Server disconnected this device: ${message.reason}`); socket.close(4003, message.reason); }
    if (message.type !== 'computer.request') return;
    const error = !state || message.deviceId !== state.deviceId ? 'device ID mismatch'
      : completed.has(message.requestId) ? 'duplicate request ID'
        : Date.now() >= message.deadline ? 'expired deadline'
          : !allowed(message.tool, message.arguments) ? 'CUA policy denied this request' : null;
    completed.add(message.requestId);
    if (error) console.error(`${color.yellow}[warn] Refused ${message.tool}: ${error}${color.reset}`);
    else log(`[info] Running ${message.tool} ...`);
    try {
      const result = error ? undefined : await driver.call(message.tool, message.arguments);
      if (!error) log(`[info] ${message.tool} completed.`);
      socket.send(JSON.stringify({ type: 'computer.result', protocolVersion: VERSION, requestId: message.requestId, deviceId: message.deviceId, ...(error ? { error } : { result }) }));
    } catch (cause) {
      const failureMessage = cause instanceof Error ? cause.message : 'CUA Driver failed';
      console.error(`${color.red}[error] ${message.tool} failed: ${failureMessage}${color.reset}`);
      if (process.platform === 'darwin' && /permission/iu.test(failureMessage)) {
        console.error(`${color.yellow}[hint] Run this companion once with --grant-permissions to request macOS Accessibility and Screen Recording access for CUA Driver, then retry.${color.reset}`);
      }
      socket.send(JSON.stringify({ type: 'computer.result', protocolVersion: VERSION, requestId: message.requestId, deviceId: message.deviceId, error: failureMessage }));
    }
  });
  socket.on('close', (code, reasonBuffer) => {
    const reason = reasonBuffer?.toString() || '';
    const detail = lastError ? ` (${lastError})` : '';
    if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
      console.error(`${color.red}[error] The server rejected the connection before the WebSocket handshake (HTTP ${httpStatus}).${color.reset}`);
      console.error(`${color.red}[error] This is usually a reverse proxy or auth middleware (OIDC, basic auth, etc.) blocking the /remote-cua path, not the companion itself. The companion authenticates with its own pairing token/device credential and cannot complete a login page or SSO challenge. Exclude /remote-cua from that middleware, then retry.${color.reset}`);
      process.exit(1);
    }
    retryCount += 1;
    if (retryCount >= 10 && httpStatus !== undefined) {
      console.error(`${color.red}[error] Giving up after ${retryCount} failed attempts (last HTTP status: ${httpStatus}). Fix the server/proxy configuration and rerun.${color.reset}`);
      process.exit(1);
    }
    if (code === 1008) { console.error(`${color.red}[error] Server rejected this connection${reason ? `: ${reason}` : '.'} Check the pairing token or server URL.${color.reset}`); process.exit(1); }
    else if (code === 1015 || (code === 1006 && /certificate|tls|ssl/iu.test(lastError ?? ''))) {
      console.error(`${color.yellow}[warn] TLS handshake failed connecting to ${url}${detail}. If this server uses a locally-signed certificate, pass --ca-cert=/path/to/ca.pem (or set NODE_EXTRA_CA_CERTS). Retrying in 2s...${color.reset}`);
    } else {
      const statusNote = httpStatus ? ` (HTTP ${httpStatus})` : '';
      log(`[info] Disconnected (code ${code}${statusNote}${reason ? `: ${reason}` : ''}${detail}). Retrying in 2s...`);
    }
    setTimeout(connect, 2_000);
  });
  // Some runtimes (Bun) surface TLS/network failures as a bare ErrorEvent
  // with no message; Node's ws gives a real message. Keep whichever we get
  // and report it alongside 'close', which always fires right after.
  socket.on('error', cause => { lastError = cause instanceof Error ? cause.message : undefined; });
}
process.on('SIGINT', () => { driver.close(); process.exit(0); });
connect();
