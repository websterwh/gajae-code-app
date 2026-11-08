# Remote agent-desktop companion

The companion lets a Gajae server use the existing reviewed `computer` tool on a paired laptop. It opens one authenticated outbound WebSocket to the server. It never opens a listener, mounts a display socket, or provides a general MCP, shell, filesystem, clipboard, browser, or remote-desktop proxy.

## Pair and run

1. In **Settings → Automation → Computer use**, keep the master switch off until native application automation is intended. Create a pairing code under **Remote devices**.
2. Install [`agent-desktop`](https://github.com/vercel-labs/agent-desktop) - it is **not** bundled with the companion binary itself; the companion is a thin WebSocket client that spawns `agent-desktop mcp` as a subprocess and otherwise does nothing on its own. Three ways to get it, in order of convenience:
   - `./gajae-agent-desktop-companion --install-agent-desktop` - downloads the matching release tarball directly from `vercel-labs/agent-desktop`'s GitHub Releases, verifies its published sha256, and installs it under this OS's config directory. No Node/npm required. Once installed, every other companion command picks it up automatically with no `--executable` flag or `PATH` change needed.
   - `npm install -g agent-desktop` (requires Node).
   - `brew install vercel-labs/tap/agent-desktop` (macOS).

   To remove it again: delete whatever the chosen method installed (for `--install-agent-desktop`, that is the `agent-desktop` subfolder next to the companion's stored credential - see `--state` below for the parent directory; for npm/brew, use that tool's own uninstall). Then run the companion with the generated pairing command.

```sh
./gajae-agent-desktop-companion --server=gajae.example --pair=PAIRING_TOKEN
```

A pairing token is a convenience, not a requirement: running with only `--server` (no `--pair`) also registers a brand-new device - it still starts out needing approval exactly like a token pairing does, so skipping the token only skips copying it out of Settings first, it never skips the Trust step below.

```sh
./gajae-agent-desktop-companion --server=gajae.example
```

`--server` accepts a bare domain; `wss://` and the `/remote-cua` path are filled in automatically. Pass a full URL instead (e.g. with a non-default port or path, or explicit `ws://` for local development) and it is used as given. Pass `--executable=/path/to/agent-desktop` if the `agent-desktop` CLI is not on `PATH`.

The companion stores its device credential under its OS config directory (`device.json`, mode `0600` on Unix). A pairing token's approval is implicit: it had to be copied out of this server's own Settings page, so a token-paired device is trusted and ready to use immediately. A device registered with only `--server` (no `--pair`) has proven nothing, so it shows up in Settings as "Needs approval" instead - click **Trust** before it can run anything. In that pending state the companion authenticates and reconnects fine (the terminal prints `Connected but not yet approved - check the web UI's Settings > Automation > Remote devices page and Trust this device.`) but never even starts `agent-desktop` or triggers an OS permission prompt - that only happens once this device is actually approved. **Untrust** pauses a device without deleting it (toggle **Trust** again to resume); **Remove** deletes the device outright and disconnects any live companion session using its credential - the companion is not blocked from reconnecting afterward either way: run it again and it registers as a new device needing approval again, the same as a first-time pairing. A `--pair=<token>` is retried on every connection attempt, even one with an existing stored credential, so passing a fresh token after a device was removed or untrusted for too long always works, not just on the very first run.

Run `./gajae-agent-desktop-companion --grant-permissions` once per machine (or any time later if a tool call fails on a permission error) to check the OS's current accessibility/screen-recording state and, if anything is missing, actually request it - calling `agent-desktop`'s own `permissions --request` (plus `--guide`, which opens System Settings with an on-screen walkthrough, on macOS). It does not need `--server` or `--pair`. On the normal `--server` connect path, the same check runs automatically exactly once, right after this device is approved - never before, and never for a device that is not yet trusted.

Expect `automation: unknown` (the System Events permission, used for macOS automation of other apps) to stay `unknown` after `--grant-permissions` even once Accessibility and Screen Recording show `granted` - this is intentional, per agent-desktop's own macOS skill documentation: Automation is never pre-requestable, it only ever prompts macOS the first time a command that actually needs it runs, and `unknown` is exactly its normal pending state until that first real use.

Run with `--help` to see every flag.

Production servers must expose `wss://` (TLS). Plain `ws://` is accepted only for explicit non-production localhost development. LAN, VPN, and reverse-tunnel deployments still require TLS and device credentials; network location is not authentication.

If a reverse proxy (nginx, godoxy, Caddy, etc.) terminates TLS and forwards plain HTTP to this server - a normal, secure setup - set `GAJAE_TRUST_PROXY_TLS=1` so the server honors the proxy's `X-Forwarded-Proto: https` header for this check. Without it, every `/remote-cua` upgrade behind such a proxy is rejected, since the socket this process sees is never directly encrypted. This variable must only be set when every path that can reach this process is in fact behind that proxy; otherwise a direct connection could forge the header and bypass the TLS requirement entirely.

If the public hostname sits behind SSO/OIDC middleware (Pocket ID, Authelia, Authentik, etc.), exclude the `/remote-cua` path from it. The companion authenticates with its own pairing token or device credential in the first protocol frame; it has no browser to complete a login redirect, so the middleware's rejection (401/403) looks identical to a misconfigured server and the companion now exits immediately instead of retrying forever. For godoxy specifically, add a path-scoped bypass, e.g. in the route's labels:

```yaml
proxy.gjc.middlewares.auth.exclude: /remote-cua
```

(the exact label name depends on your godoxy OIDC middleware config - the requirement is only that `/remote-cua` reaches the app without the SSO challenge).

The Settings download button's URL is baked into the Docker image at build
time, derived from the `APP_REPOSITORY` build argument used to build it (see
`docker/Dockerfile`), so each fork's image points at that fork's own GitHub
Releases automatically with no runtime configuration. Override it only if
needed by setting `GAJAE_COMPANION_DOWNLOAD_TEMPLATE` on the server to a URL
template containing a `{platform}` placeholder, for example
`https://github.com/OWNER/REPO/releases/latest/download/gajae-agent-desktop-companion-{platform}`.
The button is hidden only if neither the baked-in default nor an override
resolves to a valid template.

## Safety and incident response

The server remains the authority for the app-owned `computer` tool, application grants, session binding, and validation. The companion independently accepts only the reviewed `desktop_*` tools and rejects foreground delivery, desktop scope, unbound input, expired deadlines, duplicate IDs, and device mismatches.

A device is ready only while its authenticated companion is connected and reports compatible agent-desktop schema/version readiness. Ensure the `agent-desktop` CLI and its accessibility permissions (macOS: Accessibility + Screen Recording; Linux: a reachable Wayland/X11 session) are granted on the laptop. Disable, disconnect, or remove a device in Settings to stop calls; removal revokes its credential and terminates the connection. Rotate server TLS credentials and remove affected devices after suspected credential loss.

This is not remote desktop support. It provides only the agent-desktop capabilities exposed by the existing background-only reviewed action set; it cannot transfer files or record the screen beyond the `desktop_screenshot`/`desktop_trace_export` tools already in the reviewed set, and it cannot control browser backends directly.
