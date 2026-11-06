# Gajae CUA Companion (debug runtime)

This directory is the Node runtime used while the native companion is under
development. It is intentionally runnable without a build:

```sh
node cua-companion.mjs --server=wss://gajae.example/remote-cua --pair=TOKEN
```

Install CUA Driver through the companion instead of copying shell snippets:

```sh
node cua-companion.mjs --install-driver=portable
node cua-companion.mjs --install-driver=system
```

The portable default is `~/.gajae-cua` (no space, so it's always safe to use
unquoted in scripts). Override with `--portable-dir=PATH`. The companion
locates an already-installed driver at that path automatically on later runs
(or at `$CUA_DRIVER_PATH` if set); you never need to touch `PATH`.

`portable` uses CUA's supported `--prefix` and `--no-modify-path` options.
`system` delegates to CUA's current official installer. Both install only the
driver. CUA's installer always verifies sha256; pass
`--require-signature=true` to additionally require minisign or cosign
verification once one of those tools is installed (most machines don't have
them, so this is off by default rather than hard-failing the install).

Run `--register-protocol` once after downloading the CLI on Linux or Windows;
it registers `gajae-cua://` for one-click pairing in the browser. On macOS,
deep-link registration is not implemented yet; use the CLI directly.

Linux executables deliberately have no filename extension; mark them executable
after downloading (`chmod +x gajae-cua-companion-linux-x64`). Windows releases
end in `.exe`. On macOS, download the raw `gajae-cua-companion-darwin-arm64` (or
`-x64`) binary and run it from Terminal. If it still crashes with an
illegal-instruction panic despite the JIT workaround above, install
Node.js and run the plain script instead - it needs only the `ws`
package, with no build step:

```sh
npm install ws
curl -fsSLO https://raw.githubusercontent.com/websterwh/gajae-code-app/feat/remote-cua-companion/companion/cua-companion.mjs
node cua-companion.mjs --server=gjc.example.com --pair=TOKEN
```

```sh
chmod +x gajae-cua-companion-darwin-arm64
./gajae-cua-companion-darwin-arm64 --install-driver=portable
./gajae-cua-companion-darwin-arm64 --server=wss://your-server/remote-cua --pair=TOKEN
```

The `.app`/`.dmg` release currently wraps this same binary with no GUI
pairing/settings screen yet; it must still be run from Terminal, so prefer the
raw CLI binary above until the real GUI ships.

Released x64 binaries target the Nehalem/SSE4.2 baseline (not AVX2) for
ahead-of-time-compiled code. On macOS specifically, a compiled executable
also disables Bun's JIT automatically (`BUN_JSC_useJIT=0`, applied by
re-executing itself once at startup): Bun's JIT emits AVX2 instructions at
runtime regardless of the baseline compile target, which still panics with
an illegal-instruction crash on a non-AVX2 Intel Mac even with `-baseline`.
This has only been verified against the crash signature observed on an
Intel MacBook Air (macOS 14.4.1, Bun 1.4.0); it has not been verified
against a real Mac by the person making this change, since no macOS test
machine is available here - if it still crashes, the Node script
(`cua-companion.mjs`) run directly under a real Node install is unaffected
by any Bun bug and is the fallback.

If the server certificate is locally-signed (common for LAN/VPN setups), pass
`--ca-cert=/path/to/ca.pem` (or set `NODE_EXTRA_CA_CERTS`); the OS/browser
trusting it is not enough because this runtime's TLS stack does not consult
the OS trust store.
