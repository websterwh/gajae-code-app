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
driver and require its signatures where CUA publishes them.

Run `--register-protocol` once after downloading the CLI on Linux or Windows;
it registers `gajae-cua://` for one-click pairing in the browser. macOS release
packages use an app bundle, whose first launch registers the scheme.
