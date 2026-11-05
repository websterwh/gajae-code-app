# Remote CUA Driver companion

The companion lets a Gajae server use the existing reviewed `computer` actions on a paired laptop. It opens one authenticated outbound WebSocket to the server. It never opens a listener, mounts a display socket, or provides a general MCP, shell, filesystem, clipboard, browser, or remote-desktop proxy.

## Pair and run

1. In **Settings → Automation → Computer use**, keep the master switch off until native application automation is intended. Create a pairing code under **Remote devices**.
2. On the laptop with `cua-driver` installed and its OS permissions granted, run:

```sh
gajae-cua-companion --server=wss://gajae.example/remote-cua --pair=PAIRING_TOKEN
```

The companion stores its device credential at `~/.config/gajae-cua-companion/device.json` with mode `0600`. Pairing tokens are single-use and expire after ten minutes. Enable the paired device from Settings before it can authenticate after reconnecting.

Production servers must expose `wss://` (TLS). Plain `ws://` is accepted only for explicit non-production localhost development. LAN, VPN, and reverse-tunnel deployments still require TLS and device credentials; network location is not authentication.

Set `GAJAE_COMPANION_DOWNLOAD_TEMPLATE` on the server to the public release URL
template, with `{platform}` as a placeholder (for example,
`https://github.com/OWNER/REPO/releases/latest/download/gajae-cua-companion-{platform}`).
This is deployment configuration, not source code. The Settings download button is
shown only when the template is configured.

## Safety and incident response

The server remains the authority for the app-owned `computer` tool, application grants, session binding, and validation. The companion independently accepts only the reviewed CUA Driver tools and rejects foreground delivery, desktop scope, unbound input, expired deadlines, duplicate IDs, and device mismatches.

A device is ready only while its authenticated companion is connected and reports compatible CUA Driver readiness. Ensure the CUA Driver daemon and its Accessibility/screen-capture permissions are granted on the laptop. Disable, disconnect, or remove a device in Settings to stop calls; removal revokes its credential and terminates the connection. Rotate server TLS credentials and remove affected devices after suspected credential loss.

This is not remote desktop support. It provides only the CUA Driver capabilities exposed by the existing background-only reviewed action set; it cannot move the real pointer, deliver foreground or desktop-scoped input, transfer files, read the clipboard, record the screen, or control browser backends.
