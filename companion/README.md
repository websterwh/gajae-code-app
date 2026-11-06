# Gajae CUA Companion (debug runtime)

This directory is the Node runtime used while the native companion is under
development. It is intentionally runnable without a build:

```sh
node cua-companion.mjs --server=wss://gajae.example/remote-cua --pair=TOKEN
```

Install CUA Driver through the companion instead of copying shell snippets:

```sh
node cua-companion.mjs --install-driver=portable --portable-dir="$HOME/Gajae CUA"
node cua-companion.mjs --install-driver=system
```

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
`-x64`) binary and run it from Terminal:

```sh
chmod +x gajae-cua-companion-darwin-arm64
./gajae-cua-companion-darwin-arm64 --install-driver=portable
./gajae-cua-companion-darwin-arm64 --server=wss://your-server/remote-cua --pair=TOKEN
```

The `.app`/`.dmg` release currently wraps this same binary with no GUI
pairing/settings screen yet; it must still be run from Terminal, so prefer the
raw CLI binary above until the real GUI ships.
