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
init system and service manager, package manager, containers, block devices and
mounts, pools, RAID, swap, memory and load, addresses, gateway, listeners,
services, timers and cron, LXC guests and VMs, temperatures and UPS, LSM/cgroup,
and a quirks list covering the things that actually bite - a non-systemd init, a
TLS proxy in front of the app, the app container's own ports, a missing `ss`. It
ends with the rules: host is not the container, start read-only, do not prune or
restart the proxy.

The probes detect shape, not brand. A host whose root is a read-only or
image-unpacked filesystem is reported as such - root filesystem type, `ro` flag,
and the mounts that are actually writable - so the generated file answers "where
does state survive" and "what breaks if I reboot" without knowing the product it
is running on. The same applies to supervision (`systemctl`, `rc-status`,
`service --status-all`: whichever exists is named), storage (unmounted block
devices, `/proc/mdstat`, `zpool` when present), swap including zram, workloads
beyond Docker, default route, cron files outside `/etc/crontab`, `sensors` and a
NUT UPS. Each of those becomes a quirk line only when it is present and unusual.

## How the app reaches the host

Not through the companion, and not through the `/remote-host` pairing channel
that the desktop companion uses. Host control is a separate, opt-in surface:

1. **An env var turns the feature on at all.** Nothing below is mounted,
   registered or reachable when it is absent, so an image that is deployed
   without it cannot be talked into host control by a setting, a request or a
   crafted container name.
2. **Per-capability switches in Settings.** Even with the env var set, each
   ability - reading host/container state, restarting a container - is its own
   toggle, off until the operator turns it on.
3. **The transport is an ordinary mount.** A Docker-socket mount (or a socket
   proxy in front of one) is how the app talks to the daemon; there is no
   inbound port, no pairing token and no device registration to manage. The
   allow-listed verbs and the settings decide what a request may do with it.

The standalone agent above still works without any of this: `ssh webby node
deploy/host/gajae-host.mjs inventory` needs no mount and no env var, which is
the way to use it during an incident when the app itself is the thing that is
broken.

## The in-app surface (behind the env gate)

`server/modules/host-control/` is the app side of the socket mount:

| Route | Capability |
|---|---|
| `GET /api/host/status` | none - availability, socket path, reachability |
| `GET /api/host/info` | `facts` |
| `GET /api/host/containers` | `containers` |
| `POST /api/host/containers/:name/restart` | `restart` |
| `PUT /api/host/settings` | none - only while `GAJAE_HOST_CONTROL` is set |

Every route checks the env gate on each request, then the capability, so a
process started without the variable cannot be talked into host access and one
that loses it stops answering immediately. The client has four fixed requests
(`/_ping`, `/info`, `/containers/json?all=1`, `POST /containers/{name}/restart`)
and a container name that must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`. There
is no generic request function, so nothing above the client can reach an
endpoint that is not on that list.

## Which transport to use

Two shapes, on purpose:

- **Standalone agent (no mount, no env var):** run `gajae-host.mjs` over SSH.
  It needs nothing from the container and works when the app is the thing that
  is broken. This is the incident path.
- **In-app surface (socket mount, env var, settings):** the container talks to
  the daemon directly, and the operator holds the switch. This is the day-to-day
  path for the Automation tab.

Mounting `/var/run/docker.sock` gives the container root-equivalent control of
the host, and it is reachable from anything that can talk to the app. That is
why it is off by default, split into three capabilities, and why a socket proxy
that exposes only `/info` and `/containers` is the recommended form: the app
never needs the rest of the API, and `restart` is the only write it asks for.

## Verb model

| Verb | Target | Mutating |
|---|---|---|
| `host.info` | — | no |
| `host.disk` | — | no |
| `host.storage` | — | no |
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
2. **Gated transport:** `GAJAE_HOST_CONTROL` in the environment plus a mounted
   Docker socket (or proxy). No pairing, no device table, no inbound port.
3. **Per-capability settings and audit:** the Settings tab holds the switches;
   every call is recorded with what it asked for, what ran and what it returned.
4. **Mutations last:** `docker.restart` behind its own switch, then
   maintenance scripts by id. A generic shell stays out of scope - the verb
   list is the product.

Until step 2 lands, the agent is useful on its own: run `agents-md` after any host
change and it produces the briefing a session needs before it starts.
