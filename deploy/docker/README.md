# Gajae Code App Docker

Docker packaging for **Gajae Code App** (`gajae-app`), built from a revision of the [`websterwh/gajae-code-app`](https://github.com/websterwh/gajae-code-app) source fork. It includes universal package provisioning (APT/UV/Pip/NPM/Aqua), Android ADB auto-connect, and direct SSH CLI access.

This directory *is* the container project: it used to live in its own
`gajae-app-docker` repository, which meant a source change needed a push to two
repositories before an image existed. The packaging now ships with the app and
`.github/workflows/docker-publish.yml` in the app repository builds it. The
image name is unchanged (`ghcr.io/websterwh/gajae-app-docker`), so existing
compose files and pulls keep working.

---

## Highlights

- **Latest fork builds**: The image compiles the current source-fork `main` when rebuilt without Docker's cache; startup never rewrites application code.
- 🔀 **Upstream-friendly fork workflow**: Merge `devswha/gajae-code-app` into the source fork, then rebuild the image.
- 📦 **Universal Addon Package Provisioning**:
  - `APT_PACKAGES`: Comma-separated Debian packages (e.g. `openjdk-17-jre-headless,ffmpeg`).
  - `ANDROID_SDK_PACKAGES`: Android SDK components installed with Google's `sdkmanager` (e.g. `platform-tools,platforms;android-35`). No Debian package exists for the SDK, so this is the only route that keeps it on `/data`.
  - `UV_TOOLS`: Standalone Python CLI tools / MCP servers (e.g. `serena,canvas-mcp-server`).
  - `PIP_PACKAGES`: Global Python packages via `uv pip install --system --break-system-packages`.
  - `NPM_PACKAGES`: Global Node packages via `npm install -g` (installed under `/data/npm-global`).
  - `GITHUB_APPS`: GitHub release CLI binaries via Aqua (e.g. `skylot/jadx,iBotPeaches/Apktool`).
- ⚡ **Persistent Disk Caching**: APT archives, UV tools, Pip wheels, Aqua downloads, and NPM caches are rooted in `/data/cache/` for instant, cached boots.
- 💻 **Direct Container SSH Access**: In-container SSH daemon (`SSH_ENABLE=true`, port `2222`) that opens into the workspace root (`/workspace`) by default, and can drop you straight into an interactive `gjc` coding session. Supports keyless/passwordless (`SSH_NO_AUTH=true`), passwords, or SSH public keys.
- 🛡️ **Zero Host Docker Socket Dependency**: Never mounts `/var/run/docker.sock`.

---

## Quick Start

### 1. Using Docker Compose (Recommended)

1. Clone the app repository:
   ```bash
   git clone https://github.com/websterwh/gajae-code-app.git
   cd gajae-code-app/deploy/docker
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   # Set API_KEY (openssl rand -hex 32) or configure OIDC sign-in first.
   # Edit .env to customize packages, SSH, or port mappings.
   ```

   The container must bind `0.0.0.0` to be port-mapped, so the port is reachable
   from wherever it is published. With neither `API_KEY` nor sign-in configured
   the server refuses to start rather than serving an open shell.

3. Build and start the container:
   ```bash
   docker compose up -d --build
   ```

4. Access the Web UI:
   Navigate to **`http://localhost:3001`** in your browser.

5. (Optional) Connect via SSH directly to GJC CLI:
   If `SSH_ENABLE=true` and `SSH_PORT=2222`:
   ```bash
   ssh -p 2222 root@localhost
   ```

---

## Updating the App Fork

The container never applies runtime patches. Application changes belong in
[`websterwh/gajae-code-app`](https://github.com/websterwh/gajae-code-app).
After cloning that fork, configure its upstream remote once:

```bash
git remote add upstream https://github.com/devswha/gajae-code-app.git
git fetch upstream
git merge upstream/main
git push origin main
```

The image follows the trigger branch automatically in CI. To rebuild locally
instead, run this from the repository root (the Dockerfile clones the app
source, so the build context is only the packaging directory):

```bash
docker build --build-arg APP_REF=main -t ghcr.io/websterwh/gajae-app-docker:latest deploy/docker
```

or, from `deploy/docker`, `docker compose build --pull --no-cache && docker compose up -d`.

`APP_REF` defaults to `main`. Override it with a commit only when a fixed
revision is required.

---

## Environment Variables Specification

### Core App & Network
| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Bind address, and the only knob for it. `0.0.0.0` is required for container port mapping; `127.0.0.1` keeps the app unreachable from outside the container. A non-loopback bind with no `API_KEY` and no sign-in is refused at startup. |
| `SERVER_PORT` | `3001` | Port the internal WebUI server listens on. |
| `NO_AUTH` | `false` | Set to `true` to disable sign-in entirely as a break-glass. Saved OIDC settings are kept and apply again once it is unset. |
| `API_KEY` | *(empty)* | Shared key for non-desktop deployments. Required for a non-loopback bind unless OIDC sign-in is configured. Send it as `x-api-key`; per-user `ck_...` keys from Settings are also accepted. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Extra DNS names admitted by the host/origin check, comma separated. Literal IPs and localhost are always admitted; `*` disables the check. |
| `TRUSTED_PROXIES` | *(empty)* | Peers whose `X-Forwarded-For` is believed, comma separated IPs or CIDRs. Loopback is always trusted; another container or a proxy on another machine has to be listed, or the app judges the proxy's address instead of the browser's. Never list a client subnet. The older name `GAJAE_TRUSTED_PROXIES` is still read. |
| `DATABASE_PATH` | `/data/auth.db` | Path to persistent SQLite database. |
| `WORKSPACES_ROOT` | `/workspace` | Default directory root for GJC agent projects. |
| `GJC_WORKER_AGENT_DIR` | `/root/.gjc/agent` | Storage directory for agent sessions and custom skills. |
| `APP_REPOSITORY` | `https://github.com/websterwh/gajae-code-app.git` | Source repository cloned during the image build. Set as a Compose build argument. |
| `APP_REF` | `main` | Fork revision built into the image. Use `main` for the latest fork code or a commit for a fixed revision. Set as a Compose build argument. |

### Universal Package Provisioning
| Variable | Default | Description |
|---|---|---|
| `APT_PACKAGES` | *(empty)* | Comma-separated Debian packages to install via APT (`openjdk-17-jre-headless,ffmpeg`). |
| `ANDROID_SDK_PACKAGES` | *(empty)* | Comma-separated Android SDK components installed through the `android` manager (`platform-tools,platforms;android-35,build-tools;35.0.0`). The first install fetches Google's command-line tools into `<config root>/android-sdk`; components and accepted licenses stay there, so a recreate does not download them again. Also selectable as `android` in Settings -> Packages, which is what keeps every component in the ledger. |
| `UV_TOOLS` | *(empty)* | Comma-separated isolated Python CLI tools / MCPs via `uv tool install` (`serena`). |
| `PIP_PACKAGES` | *(empty)* | Comma-separated Python packages installed globally via `uv pip install --system --break-system-packages`. |
| `NPM_PACKAGES` | *(empty)* | Comma-separated Node packages installed globally via `npm install -g` (`typescript,prettier`). Persisted under `/data/npm-global`. |
| `GITHUB_APPS` | *(empty)* | Comma-separated GitHub release apps installed via Aqua (`skylot/jadx,iBotPeaches/Apktool`). |
| `UV_TOOL_DIR` | `<config root>/app/uv` | Where `uv tool install` puts its environments. Defaults beside `GJC_WORKER_AGENT_DIR`, so it survives with the mounted config; overridable. |
| `UV_TOOL_BIN_DIR` | `<config root>/app/bin` | Where uv tool executables appear. Prepended to `PATH` for the app and for `gjc`'s child processes; overridable. |
| `AUTO_UPDATE` | `true` | Update installed packages, the standalone GJC CLI and the image check on boot. Packages pinned to a version are skipped. Set `false` to install missing pieces without replacing working ones. |
| `POST_COMMANDS` | *(empty)* | Custom shell commands executed after provisioning (e.g. `adb connect 192.0.2.79:5555`). |

Boolean variables take `true` or `false` (`1`/`0` is still accepted for older deployments).

MemPalace has no install/update environment variable. Install and enable it from
**Settings > Memory**; the app installs the binary, MCP entry and autosave hook,
and keeps them tied to the mounted config.

Provisioning keeps a per-package ledger at `<config root>/app/provision-ledger.json`
(`/root/.gjc/app/provision-ledger.json` with the compose file). A package is
recorded as installed only after the install and its verification both succeed;
a failed package is recorded as failed and retried on the next boot. With no
config volume mounted, the ledger and tool directories resolve inside the
container layer and are lost on recreate - the standard compose file mounts
`./gjc-config` at `/root/.gjc`, so nothing special is needed there.

### Packages in Settings

Settings -> **Packages** manages the same packages without editing compose, and
persists to `<config root>/app/packages.json` on the same mount, so a package
added there is still wanted after the container is recreated. On boot every
package named in `UV_TOOLS`, `PIP_PACKAGES`, `NPM_PACKAGES` or `GITHUB_APPS` is
copied into `packages.json` if it is not there yet. That makes the env lists
seeds: once Settings lists the packages, the variables can be deleted from
`.env` without losing anything, and a recreate on a host without them keeps
installing the same set.

Removing a package in Settings only deletes its entry from that file - nothing
is uninstalled, because the binaries are shared with whatever else on the
machine uses them. `APT_PACKAGES` is not part of this: apt installs stay
declared in the compose file.
### Direct SSH & GJC CLI Access
| Variable | Default | Description |
|---|---|---|
| `SSH_ENABLE` | `false` | Enable the in-container SSH daemon. |
| `SSH_PORT` | `2222` | Internal listening port for the container SSH daemon. |
| `SSH_ALLOW_PASSWORD`| `false` | Allow password authentication for SSH. |
| `SSH_PASSWORD` | *(empty)* | Root password for SSH if password authentication is enabled. |
| `SSH_PUBLIC_KEYS` | *(empty)* | Public key(s) or URL (https://...) to authorize for SSH. |
| `SSH_NO_AUTH` | `false` | Permit passwordless/keyless direct SSH login (for trusted private networks). |
| `SSH_DEFAULT_COMMAND`| *(empty)* | Optional command to run on SSH login (leave empty to land directly in standard bash shell). |
| `INSTALL_GJC_CLI` | `true` | Create standalone launcher at `/data/bin/gjc`. |

---

## Security Notes

- **A credential is required for a remote bind.** Set `API_KEY` or configure
  OIDC sign-in before publishing the port. `ALLOW_UNAUTHENTICATED_REMOTE=true`
  exists only for an operator who deliberately wants an open instance.
- **Host admission is closed by default.** Loopback and literal IP addresses are
  admitted on their own, so `http://<lan-ip>:3001` still works. Add reverse-proxy
  DNS names to `ALLOWED_HOSTS`; `*` turns the check off and restores the
  DNS-rebinding exposure it exists to prevent.
- **Secrets are stored in plain text, as the GJC client stores them.** `auth.db`
  holds provider tokens, GitHub tokens, API keys and the OIDC client secret;
  `voice-config.json` and everything under `gjc-config/` are secret material too.
  The entrypoint applies `umask 077` and the database is created `0600`, so other
  local users cannot read them. Treat backups of `./data` and `./gjc-config` as
  credentials and encrypt them (encrypted volume, `age`, `gpg`), and never commit
  `.env` or `data/`.
- **`POST_COMMANDS` is executed with `eval` on every boot.** Keep it out of
  shared compose files and treat it like any other root shell command.

---

## Storage & Volume Layout

| Container Path | Host Path (Compose) | Purpose |
|---|---|---|
| `/data` | `./data` | Persistent SQLite database (`auth.db`), logs, caches (`apt`, `uv`, `pip`, `aqua`, `npm`), host SSH keys, installed CLI binaries (`/data/bin`), and (via entrypoint-created symlinks) `~/.gajae-app` and `~/.claude` - chat transcripts and per-provider session state, which `auth.db` only indexes by path and does not itself contain. Also linked here so tool state outlives a recreate: `~/.config` (gh auth, pip and uv config), `~/.gitconfig`, `~/.ssh`, `~/.local` (`pip install --user`, pipx), `~/.cache`, `~/.bun`, and `~/.android` (adb's host key, so an authorised device stays authorised). An existing real directory at one of these paths is adopted onto the mount once, when the mount is still empty, and left alone otherwise; nothing is deleted before it has been copied. |
| `/workspace` | `./workspace` | Projects directory where the coding agent inspects and edits code. |
| `/root/.gjc` | `./gjc-config` | Agent configurations, credentials, custom skills, chat image assets (`/root/.gjc/assets`, which the entrypoint symlinks to `~/.gajae-app/assets`), and the Android SDK (`/root/.gjc/android-sdk`) that the `android` package manager installs into. |

---

## License

MIT
