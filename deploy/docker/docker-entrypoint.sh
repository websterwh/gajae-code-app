#!/usr/bin/env bash
set -e

# Files this container writes (auth.db, voice-config.json, logs) hold provider
# tokens and per-user keys in plain text, as the GJC client stores them. Keep
# new files owner-only without changing how they are read or edited.
umask 077

# ==============================================================================
# Environment Defaults
# ==============================================================================
export HOST="${HOST:-0.0.0.0}"
export SERVER_PORT="${SERVER_PORT:-3001}"
# Host admission stays closed for DNS names unless the operator lists them;
# loopback and literal IP addresses are admitted on their own, so reaching the
# container by LAN address or localhost keeps working without `*`.
export ALLOWED_HOSTS="${ALLOWED_HOSTS:-localhost,127.0.0.1}"
export DATABASE_PATH="${DATABASE_PATH:-/data/auth.db}"
export WORKSPACES_ROOT="${WORKSPACES_ROOT:-/workspace}"
export GJC_WORKER_AGENT_DIR="${GJC_WORKER_AGENT_DIR:-/root/.gjc/agent}"
# Baked into the image at build time from APP_REPOSITORY (see Dockerfile), so
# the Settings "Download companion" button works out of the box for every
# fork's image without a separately configured env var.
export GAJAE_COMPANION_DOWNLOAD_TEMPLATE="${GAJAE_COMPANION_DOWNLOAD_TEMPLATE:-$(cat /opt/gajae-app/.companion_download_template 2>/dev/null || true)}"

# Addon / Package Provisioning Configuration
export APT_PACKAGES="${APT_PACKAGES:-}"
export UV_TOOLS="${UV_TOOLS:-}"
export PIP_PACKAGES="${PIP_PACKAGES:-}"
export NPM_PACKAGES="${NPM_PACKAGES:-}"
export GITHUB_APPS="${GITHUB_APPS:-}"
export AUTO_UPDATE_PACKAGES="${AUTO_UPDATE_PACKAGES:-true}"
export POST_COMMANDS="${POST_COMMANDS:-}"
# SSH Configuration
export SSH_ENABLE="${SSH_ENABLE:-false}"
export SSH_PORT="${SSH_PORT:-2222}"
export SSH_ALLOW_PASSWORD="${SSH_ALLOW_PASSWORD:-false}"
export SSH_PASSWORD="${SSH_PASSWORD:-}"
export SSH_PUBLIC_KEYS="${SSH_PUBLIC_KEYS:-}"
export SSH_NO_AUTH="${SSH_NO_AUTH:-false}"
export SSH_DEFAULT_COMMAND="${SSH_DEFAULT_COMMAND:-}"
export INSTALL_GJC_CLI="${INSTALL_GJC_CLI:-true}"

# Every tool root that a manager will let us move belongs on /data: a root left
# on the container layer is gone on the next recreate, and this list is the
# difference between "installed" and "installed again tomorrow".
export RUSTUP_HOME="${RUSTUP_HOME:-/data/rustup}"
export CARGO_HOME="${CARGO_HOME:-/data/cargo}"
export GEM_HOME="${GEM_HOME:-/data/gem}"
export GEM_PATH="${GEM_PATH:-/data/gem}"
export PIPX_HOME="${PIPX_HOME:-/data/pipx}"
export PIPX_BIN_DIR="${PIPX_BIN_DIR:-/root/.local/bin}"
# Ensure PATH prioritizes the persisted tool roots, /data/bin, /root/.local/bin, and aqua bin
export PATH="${CARGO_HOME}/bin:${GEM_HOME}/bin:/data/npm-global/bin:/data/bin:/root/.local/bin:/root/.local/share/aquaproj-aqua/bin:/usr/local/bin:$PATH"
export UV_CACHE_DIR="/data/cache/uv"
export PIP_CACHE_DIR="/data/cache/pip"
export UV_LINK_MODE="copy"
export AQUA_ROOT_DIR="/data/aqua"
export NPM_CONFIG_CACHE="/data/cache/npm"
export NPM_CONFIG_PREFIX="/data/npm-global"
# npm keeps its own settings in ~/.npmrc; pointing them at the mounted prefix
# means `npm config set ...` survives a recreate like the packages do.
export NPM_CONFIG_USERCONFIG="${NPM_CONFIG_USERCONFIG:-/data/npm-global/.npmrc}"
# Tool locations belong to the mounted config, not the image layer. Both stay
# overridable; when the config dir is not mounted they still resolve, inside the
# container layer, and are lost on recreate like any other unpersisted path.
gjc_config_root="$(dirname "${GJC_WORKER_AGENT_DIR}")"
export UV_TOOL_DIR="${UV_TOOL_DIR:-${gjc_config_root}/app/uv}"
export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-${gjc_config_root}/app/bin}"
mkdir -p "${UV_TOOL_DIR}" "${UV_TOOL_BIN_DIR}"
# The app and every gjc child inherit this PATH, so `serena` and friends are
# found without a second launcher.
case ":${PATH}:" in *":${UV_TOOL_BIN_DIR}:"*) ;; *) export PATH="${UV_TOOL_BIN_DIR}:${PATH}" ;; esac
# mempalace stores its palace on the mount but looks for it under $HOME, so the
# link has to be recreated on every fresh container. Newer releases resolve the
# config dir through XDG when ~/.mempalace holds nothing yet, which would put the
# palace on the container layer; naming the mounted directory directly keeps the
# palace (and the downloaded embedding model) across a recreate either way.
mempalace_root="${gjc_config_root}/mempalace"
mkdir -p "${mempalace_root}"
ln -sfn "${mempalace_root}" /root/.mempalace
export MEMPALACE_CONFIG_DIR="${MEMPALACE_CONFIG_DIR:-${mempalace_root}}"
# MemPalace is a built-in memory provider now, not an MCP catalog entry, so the
# image installs it itself. uv reuses the cached wheel on later boots.
if [ "${INSTALL_MEMPALACE:-true}" = "true" ] && command -v uv >/dev/null 2>&1; then
    if [ ! -x "${UV_TOOL_BIN_DIR}/mempalace" ]; then
        if uv tool install -q mempalace; then
            echo "[mempalace] Installed the built-in memory provider."
        else
            echo "[mempalace] Install failed; Settings > Memory can retry on the next boot." >&2
        fi
    elif [ "${AUTO_UPDATE_PACKAGES:-true}" = "true" ]; then
        uv tool upgrade -q mempalace >/dev/null 2>&1 || true
    fi
    # A login shell rebuilds PATH from /etc/profile before it reads the persisted
    # profile, and /data/bin is on every generated path. Linking the console
    # scripts there as well makes `mempalace` resolve in /run and SSH shells
    # without depending on how the profile was seeded.
    mkdir -p /data/bin
    for tool in mempalace mempalace-mcp; do
        if [ -x "${UV_TOOL_BIN_DIR}/${tool}" ] && [ ! -e "/data/bin/${tool}" ]; then
            ln -sfn "${UV_TOOL_BIN_DIR}/${tool}" "/data/bin/${tool}"
        fi
    done
fi
# The autosave hook lives beside the agent's sessions. An existing file is kept
# as-is so a local edit is never overwritten by a redeploy.
agent_root="${GJC_WORKER_AGENT_DIR:-${gjc_config_root}/agent}"
if [ ! -f "${agent_root}/hooks/post/mempalace-autosave.ts" ] && [ -f /usr/local/share/gajae-app/mempalace-autosave.ts ]; then
    mkdir -p "${agent_root}/hooks/post"
    cp /usr/local/share/gajae-app/mempalace-autosave.ts "${agent_root}/hooks/post/mempalace-autosave.ts"
fi
# ==============================================================================
# Directory & Cache Preparation
# ==============================================================================
mkdir -p "${DATABASE_PATH%/*}" "${WORKSPACES_ROOT}" "${GJC_WORKER_AGENT_DIR}" /data/logs /data/share
mkdir -p /data/bin /data/cache/apt/archives /data/cache/uv /data/cache/pip /data/cache/aqua /data/cache/npm /data/npm-global /data/ssh /data/.installed_hashes /data/rustup /data/cargo /data/gem /data/pipx
# ~/.ssh is deliberately not created here: it is linked onto /data below, and a
# real directory would make that link step skip it.
mkdir -p /var/run/sshd /var/lib/dbus

# Ensure machine-id exists and persists in /data so GJC machine-local identity is valid
if [ ! -f /data/machine-id ]; then
    od -vN 16 -An -tx1 /dev/urandom | tr -d ' \r\n' > /data/machine-id
    printf '\n' >> /data/machine-id
fi
cp -f /data/machine-id /etc/machine-id
cp -f /data/machine-id /var/lib/dbus/machine-id 2>/dev/null || true
# The application is immutable image content; only state belongs under /data.
cd /opt/gajae-app
# Point apt archive cache to persistent /data/cache/apt/archives
if [ ! -L /var/cache/apt/archives ]; then
    rm -rf /var/cache/apt/archives
    ln -sf /data/cache/apt/archives /var/cache/apt/archives
fi

# ~/.gajae-app holds the live GJC session transcripts the chat view reads
# (gjc-live-sessions), chat image assets, the local-server marker, and
# per-provider model memory; ~/.claude/projects holds Claude provider
# transcripts the same way. Neither is under DATABASE_PATH or WORKSPACES_ROOT,
# so without this they live on the container's writable layer and are wiped
# on every recreate even though auth.db (which only has the session *rows*,
# not their content) survives in /data - sessions reappear with nothing in
# them. Redirect both onto /data, the one bind-mounted persistent volume.
# No migration and no deletion here: on a fresh container neither path exists
# yet, so the symlink is created directly; if one is already a symlink from a
# touches an existing real directory only to adopt its content onto the mount
# once, and only when the mount is still empty, so nothing already persisted is
# ever overwritten and nothing is deleted before it has been copied.
# Every path here is state some tool writes into $HOME that a fresh container
# would otherwise throw away. They are redirected onto /data with the same
# rules as the transcripts above: an existing real directory is left alone, and
# nothing is ever deleted, so a wrong guess costs nothing.
#
#   ~/.config   `gh auth login`, pip config, uv config, ghcup, pipx
#   ~/.ssh      keys generated in the container and known_hosts
#   ~/.local    `pip install --user`, pipx, anything under ~/.local/bin
#   ~/.cache    browser and playwright downloads, tool scratch space
#   ~/.bun      bun's global installs and cache
#   ~/.android  adb's host key, which is what keeps a device authorised
#
# A package's files are only half of it: the config and keys it writes into
# $HOME are what make the next boot behave like the last one. Anything that
# does not fit one of these directories has to be redirected the way
# RUSTUP_HOME/CARGO_HOME are above, or it is reinstalled or re-authorised on
# every recreate.
# ~/.cargo and ~/.rustup are not mapped: they are redirected to /data with
# RUSTUP_HOME/CARGO_HOME above instead. A symlink would hide a toolchain the
# image ships in ~; the env override cannot.
# The image itself must not ship content in these paths, or the link would hide
# it; the Dockerfile installs binaries into /usr/local and /opt instead.
for mapping in \
    "/root/.gajae-app:/data/gajae-app" \
    "/root/.claude:/data/claude" \
    "/root/.config:/data/config" \
    "/root/.ssh:/data/ssh" \
    "/root/.local:/data/local" \
    "/root/.cache:/data/cache" \
    "/root/.bun:/data/bun" \
    "/root/.android:/data/android"; do
    target="${mapping%%:*}"
    persisted="${mapping##*:}"
    mkdir -p "${persisted}"
    if [ -d "${target}" ] && [ ! -L "${target}" ] && [ -z "$(ls -A "${persisted}" 2>/dev/null)" ]; then
        # Something already wrote this directory on the container layer (an
        # adb key, an SSH key) and nothing has been persisted yet: move it onto
        # the mount before linking, so the current authorisation survives the
        # recreate instead of being stranded on a layer that is about to go.
        # The copy is additive and only removed on success.
        if cp -an "${target}/." "${persisted}/"; then
            rm -rf "${target}"
        fi
    fi
    if [ ! -e "${target}" ] || [ -L "${target}" ]; then
        ln -sfn "${persisted}" "${target}"
    fi
done

# `git config --global` writes ~/.gitconfig, not ~/.config/git/config, so the
# identity saved in Settings would still be lost on a recreate. The file is
# created on the mount and linked, which needs a file rather than a directory.
if [ ! -e /root/.gitconfig ] || [ -L /root/.gitconfig ]; then
    mkdir -p /data/git
    [ -f /data/git/gitconfig ] || : > /data/git/gitconfig
    ln -sfn /data/git/gitconfig /root/.gitconfig
fi

# Chat image assets live on the config volume instead of a mount of their own:
# /root/.gjc is already bind-mounted for credentials and skills, so one mount
# carries images too. The server still writes to ~/.gajae-app/assets, and this
# symlink means no code has to know where the bytes really are.
assets_store="/root/.gjc/assets"
assets_path="/root/.gajae-app/assets"
mkdir -p "${assets_store}" "$(dirname "${assets_path}")"
if [ -d "${assets_path}" ] && [ ! -L "${assets_path}" ]; then
    # First boot after the move keeps the images uploaded before it. If the
    # copy fails the old directory stays in place, so nothing is ever deleted
    # before it has been copied.
    if cp -an "${assets_path}/." "${assets_store}/"; then
        rm -rf "${assets_path}"
    fi
fi
if [ ! -e "${assets_path}" ] || [ -L "${assets_path}" ]; then
    ln -sfn "${assets_store}" "${assets_path}"
fi

# Ensure bun is in PATH if present in dist-native
if [ -f "/opt/gajae-app/dist-native/bun" ] && [ ! -f "/usr/local/bin/bun" ]; then
    ln -sf /opt/gajae-app/dist-native/bun /usr/local/bin/bun
    chmod +x /opt/gajae-app/dist-native/bun 2>/dev/null || true
fi
# ==============================================================================
# Helper: Comma-separated Parser
# ==============================================================================
parse_csv() {
    local input="$1"
    IFS=',' read -ra items <<< "$input"
    for item in "${items[@]}"; do
        item="$(echo "$item" | xargs)"
        [ -n "$item" ] && echo "$item"
    done
}

# ==============================================================================
# Provisioning: APT Packages
# ==============================================================================
# A name in APT_PACKAGES is not always a package: Debian also has virtual
# names, which a real package Provides. `android-tools-adb` is provided by
# `adb`, so asking dpkg about the virtual name answers "no packages found" even
# when the tool is installed - and a boot that trusted that answer reinstalled
# it every time, or worse, judged it missing after a good install.
apt_installed() {
    local name="$1"
    dpkg-query -W -f='${Status}' "$name" 2>/dev/null | grep -qx 'install ok installed' && return 0
    # Any installed package that Provides this name satisfies it. The Provides
    # field is a comma list and may carry a version constraint to strip.
    dpkg-query -W -f='${Status}\t${Provides}\n' 2>/dev/null \
        | awk -F'\t' '$1 == "install ok installed" && $2 != "" { print $2 }' \
        | tr ',' '\n' \
        | sed 's/^[[:space:]]*//; s/[[:space:](].*$//' \
        | grep -qx "$name"
}

# The one package that Provides a virtual name, when there is exactly one. Two
# or more is a choice apt itself refuses to make silently, so this makes none.
apt_provider() {
    local providers
    providers="$(apt-cache showpkg "$1" 2>/dev/null | awk '/^Reverse Provides:/ { found = 1; next } found && NF { print $1 }')"
    [ "$(printf '%s\n' "$providers" | grep -c .)" -eq 1 ] && printf '%s\n' "$providers"
}

provision_apt() {
    if [ -z "${APT_PACKAGES}" ]; then
        return 0
    fi

    local current_hash
    current_hash="$(echo -n "${APT_PACKAGES}" | md5sum | awk '{print $1}')"
    local saved_hash_file="/data/.installed_hashes/apt.hash"
    local previous_hash=""
    [ -f "$saved_hash_file" ] && previous_hash="$(cat "$saved_hash_file")"
    local pkg_list=()
    while IFS= read -r pkg; do
        pkg_list+=("$pkg")
    done < <(parse_csv "${APT_PACKAGES}")
    local packages_missing="false"
    for pkg in "${pkg_list[@]}"; do
        if ! apt_installed "$pkg"; then
            packages_missing="true"
            break
        fi
    done

    if [ "$current_hash" != "$previous_hash" ] || [ "$packages_missing" = "true" ]; then
        echo "==> [APT] Provisioning: ${APT_PACKAGES}..."

        if [ ${#pkg_list[@]} -gt 0 ]; then
            # A container may have been stopped during a previous install.
            # Complete any unpacked packages before invoking apt again.
            DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true
            DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
            local failed="false"
            local provider=""
            for pkg in "${pkg_list[@]}"; do
                apt_installed "$pkg" && continue
                # One name apt cannot resolve aborts the whole transaction, so
                # a typo used to leave every other package in the list
                # uninstalled. Each name is its own install now, and a failure
                # is reported instead of being swallowed by >/dev/null.
                if DEBIAN_FRONTEND=noninteractive apt-get install -qq -y --no-install-recommends "$pkg"; then
                    continue
                fi
                # A virtual name apt would not resolve on its own: install the
                # single package that provides it, which is what the name meant.
                provider="$(apt_provider "$pkg" || true)"
                if [ -n "$provider" ] && DEBIAN_FRONTEND=noninteractive apt-get install -qq -y --no-install-recommends "$provider"; then
                    echo "==> [APT] ${pkg} is a virtual name; installed ${provider}, which provides it."
                    continue
                fi
                failed="true"
                echo "==> [APT] ${pkg} failed to install; the remaining packages continue." >&2
            done
        fi
        if [ "${failed:-false}" = "false" ]; then
            echo "$current_hash" > "$saved_hash_file"
            echo "==> [APT] Finished provisioning packages."
        else
            # The hash is not saved: the next boot retries the failed names
            # instead of remembering them as installed.
            rm -f "$saved_hash_file"
            echo "==> [APT] Finished with failures; they are retried on the next boot." >&2
        fi
    elif [ "${AUTO_UPDATE_PACKAGES}" = "true" ] || [ "${AUTO_UPDATE_PACKAGES}" = "1" ]; then
        echo "==> [APT] Checking for updates on installed packages..."
        apt-get update -qq || true
        local upgradable
        upgradable="$(apt-get --just-print upgrade 2>/dev/null | grep -E '^Inst ' || true)"
        if [ -n "$upgradable" ]; then
            echo "==> [APT] Upgrades available. Updating packages..."
            DEBIAN_FRONTEND=noninteractive apt-get upgrade -qq -y >/dev/null || true
            echo "==> [APT] Finished upgrading packages."
        else
            echo "==> [APT] Packages are up to date."
        fi
    fi
}

# The image deletes /var/lib/apt/lists to keep its layers small, which leaves
# `apt-cache search` - the package search in Settings - answering every query
# with nothing. Rebuild the index once here so the first search is instant; the
# suggestion service repeats this if the archive was unreachable at boot.
if ! ls /var/lib/apt/lists/*Packages* >/dev/null 2>&1; then
    apt-get update -qq || true
fi

# ==============================================================================
# Provisioning: Python, Node and GitHub packages
# ==============================================================================
# Install/verify/ledger rules live in server/modules/mcp/provision.ts and run
# through this CLI, so the entrypoint keeps no second copy. A failed package is
# recorded as failed and retried on the next boot, never marked installed.
provision_packages() {
    node /opt/gajae-app/dist-server/server/modules/mcp/provision-cli.js || true
}

# ==============================================================================
# Provisioning: Standalone GJC CLI Binary
# ==============================================================================
provision_gjc_cli() {
    if [ "${INSTALL_GJC_CLI}" != "true" ] && [ "${INSTALL_GJC_CLI}" != "1" ]; then
        return 0
    fi

    local standalone_bin="/data/bin/gjc-standalone"
    local latest_release
    latest_release="$(curl -fsSL -H "User-Agent: GJC-Installer" "https://api.github.com/repos/Yeachan-Heo/gajae-code/releases/latest" 2>/dev/null || true)"
    local download_url
    download_url="$(echo "$latest_release" | jq -r '.assets[] | select(.name == "gjc-linux-x64") | .browser_download_url' 2>/dev/null || true)"
    local tag
    tag="$(echo "$latest_release" | jq -r '.tag_name // empty' 2>/dev/null || true)"
    local current_ver=""
    if [ -f "/data/bin/.gjc_version" ]; then
        current_ver="$(cat /data/bin/.gjc_version)"
    fi

    # The binary lives on the mounted /data volume, so it survives a recreate.
    # Checking only whether the file exists froze every existing install on its
    # first download; the release tag has to be compared on every boot.
    if [ -n "$tag" ] && [ -n "$download_url" ] && [ "$download_url" != "null" ]; then
        if [ "$current_ver" != "$tag" ] || [ ! -f "$standalone_bin" ]; then
            echo "==> [GJC CLI] Updating standalone gjc ${current_ver:-missing} -> ${tag}..."
            if curl -fsSL --retry 2 -o "${standalone_bin}.tmp" "$download_url"; then
                mv "${standalone_bin}.tmp" "$standalone_bin" && \
                    chmod 0755 "$standalone_bin" && \
                    echo "$tag" > /data/bin/.gjc_version
                echo "==> [GJC CLI] Standalone gjc updated to ${tag}."
            else
                rm -f "${standalone_bin}.tmp"
                echo "==> [GJC CLI] Download failed; keeping ${current_ver:-the existing binary}."
            fi
        else
            echo "==> [GJC CLI] Standalone gjc ${current_ver} is current."
        fi
    else
        echo "==> [GJC CLI] Could not resolve the latest release; keeping ${current_ver:-the existing binary}."
    fi

    # Create /data/bin/gjc wrapper that runs standalone or fallback
    cat > /data/bin/gjc <<'EOF'
#!/bin/sh
if [ -x "/data/bin/gjc-standalone" ]; then
    exec /data/bin/gjc-standalone "$@"
fi
if [ -x "/root/.local/bin/gjc" ]; then
    exec /root/.local/bin/gjc "$@"
fi
exec bun /opt/gajae-app/node_modules/@gajae-code/coding-agent/bin/gjc.js "$@"
EOF
    chmod 0755 /data/bin/gjc
}

# ==============================================================================
# Post Commands Execution
# ==============================================================================
run_post_commands() {
    if [ -n "${POST_COMMANDS}" ]; then
        echo "==> [Post Commands] Executing custom post commands..."
        eval "${POST_COMMANDS}" || true
    fi
}

# ==============================================================================
# SSH Daemon Bootstrap
# ==============================================================================
setup_ssh() {
    if [ "${SSH_ENABLE}" != "true" ] && [ "${SSH_ENABLE}" != "1" ]; then
        return 0
    fi

    echo "==> [SSH] Configuring SSH daemon on port ${SSH_PORT}..."

    # Persist host keys in /data/ssh
    if [ ! -f /data/ssh/ssh_host_ed25519_key ]; then
        echo "==> [SSH] Generating persistent host ed25519 key..."
        ssh-keygen -t ed25519 -f /data/ssh/ssh_host_ed25519_key -N "" -q
    fi
    if [ ! -f /data/ssh/ssh_host_rsa_key ]; then
        echo "==> [SSH] Generating persistent host RSA key..."
        ssh-keygen -t rsa -b 4096 -f /data/ssh/ssh_host_rsa_key -N "" -q
    fi

    chmod 600 /data/ssh/ssh_host_*_key 2>/dev/null || true
    chmod 644 /data/ssh/ssh_host_*_key.pub 2>/dev/null || true

    local sshd_config="/etc/ssh/sshd_config"
    cat > "$sshd_config" <<EOF
Port ${SSH_PORT}
HostKey /data/ssh/ssh_host_ed25519_key
HostKey /data/ssh/ssh_host_rsa_key
AuthorizedKeysFile .ssh/authorized_keys
ChallengeResponseAuthentication no
UsePAM no
X11Forwarding no
PrintMotd no
AcceptEnv LANG LC_*
SetEnv PATH=${UV_TOOL_BIN_DIR}:${CARGO_HOME}/bin:/data/npm-global/bin:/data/bin:/root/.local/bin:/root/.local/share/aquaproj-aqua/bin:/usr/local/bin:/usr/bin:/bin
Subsystem sftp /usr/lib/openssh/sftp-server
EOF

    # Configure Authentication
    if [ "${SSH_NO_AUTH}" = "true" ] || [ "${SSH_NO_AUTH}" = "1" ]; then
        echo "==> [SSH] SSH_NO_AUTH is enabled. Permitting empty passwords and root login."
        cat >> "$sshd_config" <<EOF
PermitRootLogin yes
PermitEmptyPasswords yes
PasswordAuthentication yes
EOF
        passwd -d root 2>/dev/null || true
    else
        cat >> "$sshd_config" <<EOF
PermitRootLogin yes
EOF
        if [ "${SSH_ALLOW_PASSWORD}" = "true" ] || [ "${SSH_ALLOW_PASSWORD}" = "1" ]; then
            cat >> "$sshd_config" <<EOF
PasswordAuthentication yes
EOF
            if [ -n "${SSH_PASSWORD}" ]; then
                echo "root:${SSH_PASSWORD}" | chpasswd
            fi
        else
            cat >> "$sshd_config" <<EOF
PasswordAuthentication no
EOF
        fi
    fi

    # Authorized keys setup
    if [ -n "${SSH_PUBLIC_KEYS}" ]; then
        mkdir -p /root/.ssh
        touch /root/.ssh/authorized_keys
        # Check if SSH_PUBLIC_KEYS is a URL
        if [[ "${SSH_PUBLIC_KEYS}" =~ ^https?:// ]]; then
            echo "==> [SSH] Fetching public keys from URL ${SSH_PUBLIC_KEYS}..."
            curl -fsSL "${SSH_PUBLIC_KEYS}" >> /root/.ssh/authorized_keys || true
        else
            while IFS= read -r key; do
                if [ -n "$key" ]; then
                    echo "$key" >> /root/.ssh/authorized_keys
                fi
            done < <(parse_csv "${SSH_PUBLIC_KEYS}")
        fi
        chmod 700 /root/.ssh
        chmod 600 /root/.ssh/authorized_keys
    fi

    # ~/.bashrc and ~/.bash_profile are seeded on /data and linked into /root
    # before this runs (see Persistent Shell Profile). They are deliberately
    # not rewritten here: the profiles belong to the user once they exist.
    # Start sshd in background
    /usr/sbin/sshd
    echo "==> [SSH] SSH daemon running on port ${SSH_PORT}."
}

# ==============================================================================
# Run Startup Provisioners
# ==============================================================================
# The web application must be available promptly. Optional packages and tools
# can finish installing after the server begins accepting connections; required
# audio transcoding is baked into the image instead.
if [ "$#" -gt 0 ] && [ "$1" = "start" ]; then
    echo "==> [Provisioning] Optional packages continue in the background."
    (
        provision_apt
        provision_packages
        provision_gjc_cli
        run_post_commands
    ) &
else
    provision_apt
    provision_packages
    provision_gjc_cli
    run_post_commands
fi
# ==============================================================================
# Persistent Shell Profile
# ==============================================================================
# The shell profiles used to live in the image's writable layer, so an alias, a
# prompt or a PATH edit vanished on the next recreate. They are kept on the
# /data mount and linked into /root. A profile is seeded only when it is
# missing: once it exists, it is the user's file and the entrypoint leaves it
# alone.
mkdir -p /data/shell
for profile in bashrc bash_profile; do
    live="/root/.${profile}"
    stored="/data/shell/.${profile}"
    # Adopt a profile an older image wrote into the writable layer, so an
    # existing customization survives the move instead of being replaced.
    if [ -f "${live}" ] && [ ! -L "${live}" ] && [ ! -e "${stored}" ]; then
        if mv "${live}" "${stored}" 2>/dev/null; then :; else cp -p "${live}" "${stored}" && rm -f "${live}"; fi
    fi
done

if [ ! -f /data/shell/.bash_profile ]; then
    cat > /data/shell/.bash_profile <<EOF
export RUSTUP_HOME=/data/rustup
export CARGO_HOME=/data/cargo
export PATH="${UV_TOOL_BIN_DIR}:/data/cargo/bin:/data/npm-global/bin:/data/bin:/root/.local/bin:/root/.local/share/aquaproj-aqua/bin:/usr/local/bin:\$PATH"
export EDITOR="nano"
export VISUAL="nano"
if [ -f /root/.bashrc ]; then
    . /root/.bashrc
fi
if [ -d "${WORKSPACES_ROOT}" ]; then
    cd "${WORKSPACES_ROOT}" 2>/dev/null || true
fi
EOF
fi

if [ ! -f /data/shell/.bashrc ]; then
    cat > /data/shell/.bashrc <<EOF
export RUSTUP_HOME=/data/rustup
export CARGO_HOME=/data/cargo
export PATH="${UV_TOOL_BIN_DIR}:/data/cargo/bin:/data/npm-global/bin:/data/bin:/root/.local/bin:/root/.local/share/aquaproj-aqua/bin:/usr/local/bin:\$PATH"
export EDITOR="nano"
export VISUAL="nano"
# Set shell working directory to WORKSPACES_ROOT
if [ -d "${WORKSPACES_ROOT}" ]; then
    cd "${WORKSPACES_ROOT}" 2>/dev/null || true
fi

# Run custom SSH command if specified (e.g. SSH_DEFAULT_COMMAND=gjc)
if [ -n "\${SSH_DEFAULT_COMMAND:-}" ] && [ -n "\$SSH_CONNECTION" ] && [ -t 1 ] && [ -z "\$LAUNCHED_SSH_COMMAND" ]; then
    export LAUNCHED_SSH_COMMAND=1
    \${SSH_DEFAULT_COMMAND} || true
fi
EOF
fi

for profile in bashrc bash_profile; do
    live="/root/.${profile}"
    stored="/data/shell/.${profile}"
    if [ -L "${live}" ]; then ln -sfn "${stored}" "${live}"; fi
    if [ -f "${live}" ] && [ ! -L "${live}" ]; then rm -f "${live}"; fi
    if [ ! -e "${live}" ] && [ ! -L "${live}" ]; then ln -s "${stored}" "${live}"; fi
done

# uv installs the built-in tools (mempalace, the agent CLIs) into
# ${UV_TOOL_BIN_DIR}, and Debian's /etc/profile resets PATH before a login shell
# reads ~/.bash_profile. A profile seeded before that directory was on the path
# leaves `mempalace: command not found` in terminals and /run, so the directory
# is added once instead of rewriting the user's file.
for profile in /data/shell/.bashrc /data/shell/.bash_profile; do
    [ -f "${profile}" ] || continue
    grep -qF 'gajae-tool-path' "${profile}" 2>/dev/null && continue
    printf '\n# gajae-tool-path\ncase ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' "${UV_TOOL_BIN_DIR}" "${UV_TOOL_BIN_DIR}" >> "${profile}"
done

# Shell history is the one thing a terminal writes without being asked to, and
# it lives in ~/.bash_history - on the container layer. Moving it beside the
# profiles keeps `history` intact across a recreate. Appended once, like the
# PATH block above.
for profile in /data/shell/.bashrc /data/shell/.bash_profile; do
    [ -f "${profile}" ] || continue
    grep -qF 'gajae-history' "${profile}" 2>/dev/null && continue
    printf '\n# gajae-history\nexport HISTFILE=/data/shell/.bash_history\n' >> "${profile}"
done

# A GitHub token saved in Settings is written to /data/shell/github.env. Source
# it from the persisted profiles once, so SSH shells get the same variables the
# app process and its agents already have.
for profile in /data/shell/.bashrc /data/shell/.bash_profile; do
    [ -f "${profile}" ] || continue
    grep -qF 'gajae-github-env' "${profile}" 2>/dev/null && continue
    printf '\n# gajae-github-env\n[ -f /data/shell/github.env ] && . /data/shell/github.env\n' >> "${profile}"
done

setup_ssh

# ==============================================================================
# Startup Banner
# ==============================================================================
echo "=========================================================="
echo " Starting Gajae Code App Container"
echo " Source Revision: $(cat /opt/gajae-app/.image_revision 2>/dev/null || echo 'unknown')"
echo " Bind Address   : ${HOST}:${SERVER_PORT}"
echo " Allowed Hosts  : ${ALLOWED_HOSTS}"
echo " Sign-in Off    : ${NO_AUTH:-false}"
echo " Database Path  : ${DATABASE_PATH}"
echo " Workspace Root : ${WORKSPACES_ROOT}"
if [ "${SSH_ENABLE}" = "true" ] || [ "${SSH_ENABLE}" = "1" ]; then
echo " SSH Daemon     : Enabled on port ${SSH_PORT}"
fi
echo "=========================================================="

# ==============================================================================
# Image Update Check (informational only: this image's app source is baked in
# at build time, so an update means rebuilding/pulling a new image, not an
# in-place file change. See provision_gjc_cli for the one component that can
# still self-update.)
# ==============================================================================
if { [ "${AUTO_UPDATE_PACKAGES}" = "true" ] || [ "${AUTO_UPDATE_PACKAGES}" = "1" ]; } && [ -f /opt/gajae-app/.image_repository ] && [ -f /opt/gajae-app/.image_ref ]; then
    IMAGE_REPO="$(cat /opt/gajae-app/.image_repository)"
    IMAGE_REF="$(cat /opt/gajae-app/.image_ref)"
    IMAGE_COMMIT="$(cat /opt/gajae-app/.image_revision 2>/dev/null || true)"
    IMAGE_OWNER_REPO="$(echo "$IMAGE_REPO" | sed -E 's#^https://github.com/##')"
    LATEST_COMMIT="$(curl -fsSL -H "User-Agent: GJC-Installer" "https://api.github.com/repos/${IMAGE_OWNER_REPO}/commits/${IMAGE_REF}" 2>/dev/null | jq -r '.sha // empty' 2>/dev/null || true)"
    if [ -n "$LATEST_COMMIT" ] && [ -n "$IMAGE_COMMIT" ] && [ "$LATEST_COMMIT" != "$IMAGE_COMMIT" ]; then
        echo "==> [Image Update] A newer ${IMAGE_REF} commit is available upstream (this image: ${IMAGE_COMMIT:0:12}, latest: ${LATEST_COMMIT:0:12})."
        echo "==> [Image Update] Rebuild/pull the Docker image to update; app source is baked in and cannot update in place."
        echo "=========================================================="
    fi
fi

# If running a non-server command (e.g. bash, status, info)
if [ "$#" -gt 0 ] && [ "$1" != "start" ]; then
    if [ "$1" = "status" ] || [ "$1" = "info" ] || [ "$1" = "version" ]; then
        exec node /opt/gajae-app/dist-server/server/cli.js "$@"
    else
        exec "$@"
    fi
fi

# ==============================================================================
# Process Supervisor
# ==============================================================================
SERVER_PID=""

shutdown_handler() {
    echo "==> Shutting down Gajae Code App..."
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -TERM "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    exit 0
}

trap shutdown_handler SIGTERM SIGINT SIGQUIT

# Supervisor loop
while true; do
    node /opt/gajae-app/dist-server/server/cli.js start &
    SERVER_PID=$!
    wait "$SERVER_PID" || true

    sleep 1
done
