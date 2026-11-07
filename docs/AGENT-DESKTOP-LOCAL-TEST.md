# Testing agent-desktop locally (no companion/server changes needed)

agent-desktop ships its own MCP server (`agent-desktop mcp`), so you can compare
it against CUA Driver on your own machine today without touching this repo,
the companion, or Docker. This is step 1 of the `feat/agent-desktop-companion`
branch and is meant to answer "is this actually better for my real tasks"
before any server/companion rewrite lands.

## Install

```bash
npm install -g agent-desktop   # or: brew install vercel-labs/tap/agent-desktop (macOS)
agent-desktop --version
```

## Register as a local MCP server

Point your GJC agent config (or any MCP-speaking client) at:

```json
{
  "mcpServers": {
    "agent-desktop": {
      "command": "agent-desktop",
      "args": ["mcp"]
    }
  }
}
```

No pairing token, no WebSocket, no Docker involved — this runs directly on
your Mac/PC and talks accessibility-tree commands to whatever's in the
foreground.

## What you're comparing against CUA

- CUA's 16-tool safe list (`click`, `type_text`, `press_key`, `hotkey`,
  `scroll`, `get_accessibility_tree`, ...) vs. agent-desktop's 60 commands
  across app/window, observation, interaction, scroll, keyboard, mouse,
  clipboard, and system-surface groups.
- CUA addresses elements via `element_token` bound to a `pid`; agent-desktop
  addresses them via snapshot-qualified refs (`@s8f3k2p9:e3`) from a prior
  `snapshot`/`find` call — same idea (resolve-then-act), different wire shape.
- Both are accessibility-tree-first, not screenshot/pixel-matching, with an
  explicit opt-in physical-input fallback (`--headed` for agent-desktop,
  `move_cursor`/coordinate target for CUA).

## What this does NOT test

- Remote device pairing (your MacBook controlling a Docker-hosted server) —
  that's the full companion/server rewrite tracked on this branch, not yet
  done.
- Approval/consent UI, device online/offline bubble, or any of the Gajae
  Settings-tab pairing flow.

Once you've confirmed agent-desktop's command set actually fixes real task
failures (vs. CUA, which was already accessibility-tree-based — see prior
investigation), say so and the remote companion rewrite proceeds using this
same command set.
