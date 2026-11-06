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

Linux executables deliberately have no filename extension; mark them executable
after downloading (`chmod +x gajae-cua-companion-linux-x64`). Windows releases
end in `.exe`. The macOS universal `.dmg` supports both Apple Silicon and Intel;
mount it, move the app to Applications, and open it once before opening a
pairing link.
