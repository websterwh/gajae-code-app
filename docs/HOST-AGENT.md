# Host agent: scoped access to the Docker host

The app container is deliberately blind to the machine that runs it: no Docker
socket, no host bind of `/var`, no `sudo`. That is the right default, and this
directory is the narrow way around it.

## What runs today

`deploy/host/gajae-host.mjs` runs **on the host**, not in the container, and does
two things:

```sh
node deploy/host/gajae-host.mjs inventory            # host facts as JSON
node deploy/host/gajae-host.mjs agents-md --out AGENTS.md
node deploy/host/gajae-host.mjs verbs                # the allow-list
node deploy/host/gajae-host.mjs run docker.ps        # one fixed command
```

It is read-only. Nothing in `verbs.mjs` can take a command fragment: a verb is
one fixed command string, and the only caller-influenced value is a target that
must match `^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$`. `docker.inspect` accepts a
container name, `service.status` accepts a service name, and that is the entire
surface.

`agents-md` writes the file an agent reads before touching the host: OS, kernel,
init system, package manager, containers, disks, addresses, listeners, timers,
cron, LSM/cgroup, and a quirks list (`README`-style) covering the things that
actually bite - a non-systemd init, a TLS proxy in front of the app, the app
container's own ports, a missing `ss`. It ends with the rules: host is not the
container, start read-only, do not prune or restart the proxy.

## Why not the Docker socket

Mounting `/var/run/docker.sock` gives the container root-equivalent control of
the host, and it is reachable from anything that can talk to the app. The same
goes for running the container privileged or with `--pid=host`. The agent model
keeps that door shut: the container never gets host authority, it gets answers
from a small program the operator installed on the host.

## Verb model

| Verb | Target | Mutating |
|---|---|---|
| `host.info` | — | no |
| `host.disk` | — | no |
| `host.memory` | — | no |
| `host.network` | — | no |
| `host.listeners` | — | no |
| `docker.ps` | — | no |
| `docker.images` | — | no |
| `docker.inspect` | container | no |
| `service.status` | service | no |
| `docker.restart` | container | yes, declared but disabled |
| `service.restart` | service | yes, declared but disabled |

The mutating pair exists so the shape of the eventual protocol is reviewable.
`executeVerb` refuses them even with `--allow-mutating` while `enabled` is false;
enabling one is a deliberate code change, not a runtime flag.

## Recovery of the original plan

`companion/PLANNED-FEATURES.md` (deleted in `2b6ea19` when the companion moved to
Rust) described this as: limited control of the Docker host for management
tasks - restarting/updating the companion or its managed services, reading host
resource/health info to surface in the Automation tab, triggering host-side
maintenance scripts the operator allow-listed - with an explicit pairing step, a
reviewed allow-list (in the spirit of the companion's `SAFE_TOOLS`), and a
decision between reusing the outbound-only WebSocket channel or a separate one.
The placeholder in Settings still says the same thing.

## Staged plan

1. **Done here:** facts, AGENTS.md generation, the verb allow-list, and the
   refusal paths, all covered by `deploy/host/gajae-host.test.mjs`.
2. **Pairing and transport:** a `--server` mode for `gajae-host.mjs` that opens
   an outbound WebSocket to `/remote-host` (same shape as the companion's hello:
   device name, OS, one-time pairing token), so the host needs no inbound port.
   Reuse the device-credential table and the Trust/Untrust flow in Settings.
3. **Dispatch and audit:** the server sends a verb id plus target; the agent
   answers only for verbs in this file; every call lands in the Automation tab
   with its command, exit code and duration.
4. **Mutations last:** start with `docker.restart` on an operator-approved
   container list, then maintenance scripts by id. A generic shell stays out of
   scope - the verb list is the product.

Until step 2 lands, the agent is useful on its own: run `agents-md` after any host
change and it produces the briefing a session needs before it starts.
