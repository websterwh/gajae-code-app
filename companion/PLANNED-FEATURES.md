# Planned features

## Host control for the Docker-based remote CUA companion

The server-hosted/Docker deployment of the remote CUA companion cannot do
computer-use (no Accessibility/Screen Recording surface — it's a container,
not a desktop session). The Automation settings tab currently shows this as
a plain "Host control: Not available in this container" placeholder instead
of pretending to check OS permissions it can never have.

Idea to revisit later: let the container companion request limited control
of the host machine it's running on (the Docker host), for management tasks
— not full computer-use/Accessibility-style input injection, but something
narrower like:

- Restarting/updating the companion or its managed services
- Reading host resource/health info to surface in the Automation tab
- Triggering host-side maintenance scripts the operator has explicitly
  allow-listed

This needs its own transport and trust boundary (the container is not the
host), a reviewed allow-list of operations (same spirit as `SAFE_TOOLS` in
`cua-companion.mjs`), and a decision on whether it reuses the existing
outbound-only WebSocket channel or needs a separate one scoped to host
management only. Not started — no design yet, just the placeholder swap
that prompted writing this down.

## Requesting CUA Driver permissions on Windows and Linux

The companion ships `--grant-permissions` to request macOS's Accessibility
and Screen Recording TCC grants for CUA Driver, by shelling out to
`cua-driver permissions grant` / `permissions status`. That's macOS-only:
it is the only platform where `cua-driver` currently exposes a `permissions`
subcommand, because it is the only platform with a user-facing OS permission
gate in front of accessibility/screen APIs today.

Windows and Linux CUA Driver builds (UI Automation and AT-SPI 2 respectively)
do not have an equivalent interactive grant step documented upstream yet - a
request there either succeeds outright under the signed-in desktop session or
fails for a different reason entirely (missing AT-SPI bus, no desktop
session, UIA access denied by policy). If/when `cua-driver` grows a
`permissions`-style command for either platform, `grantPermissions()` in
`cua-companion.mjs` should grow a second branch for it instead of only
throwing "not implemented" outside macOS, and the startup/failure hints that
currently gate on `process.platform === 'darwin'` should be extended to
match. Not started - blocked on cua-driver itself publishing that surface.
