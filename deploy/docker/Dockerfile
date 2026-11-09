# The upstream bundle contract requires the Linux binaries to be compiled on
# glibc 2.35 (Ubuntu 22.04/Jammy).
#
# This packaging lives in `deploy/docker` of the app repository; the workflow in
# `.github/workflows/docker-publish.yml` builds it with this directory as the
# build context and passes the triggering branch as APP_REF.
FROM ubuntu:22.04 AS app-build

ARG APP_REPOSITORY=https://github.com/websterwh/gajae-code-app.git
ARG APP_REF=main
ARG APP_SOURCE_REFRESH=manual

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python3 \
    make \
    g++ \
    tar \
    gzip \
    unzip \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /src
RUN git clone "${APP_REPOSITORY}" . && \
    git fetch --depth=1 origin "${APP_REF}" && \
    git checkout --detach FETCH_HEAD && \
    test -n "${APP_SOURCE_REFRESH}" && \
    APP_COMMIT="$(git rev-parse HEAD)" && \
    npm ci && \
    node scripts/fetch-bun.mjs && \
    npm run server:bundle && \
    mkdir /opt/gajae-app && \
    tar -xzf release/server/gajae-app-server-*-linux-x64-node22.tar.gz -C /opt/gajae-app && \
    printf '%s\n' "${APP_COMMIT}" > /opt/gajae-app/.image_revision && \
    APP_REPOSITORY_WEB="${APP_REPOSITORY%.git}" && \
    printf '%s\n' "${APP_REPOSITORY_WEB}/releases/latest/download/gajae-agent-desktop-companion-{platform}" > /opt/gajae-app/.companion_download_template && \
    printf '%s\n' "${APP_REPOSITORY_WEB}" > /opt/gajae-app/.image_repository && \
    printf '%s\n' "${APP_REF}" > /opt/gajae-app/.image_ref

# Split the runtime tree: the dependency directory changes only when the lockfile
# does, while the code changes on every commit. Kept as two directories so the
# final image can layer them separately.
RUN mkdir -p /opt/gajae-deps && mv /opt/gajae-app/node_modules /opt/gajae-deps/node_modules

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="Gajae Code App" \
      org.opencontainers.image.description="Container image for Gajae Code App fork builds with SSH and package provisioning" \
      org.opencontainers.image.source="https://github.com/websterwh/gajae-code-app" \
      org.opencontainers.image.licenses="MIT"

# Install system dependencies:
# - build / archive tools & utilities
# - openssh-server for container SSH access
# - Playwright / Chromium headless rendering dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    apt-utils \
    ca-certificates \
    curl \
    git \
    nano \
    vim-tiny \
    busybox \
    python3 \
    python3-pip \
    procps \
    tar \
    gzip \
    unzip \
    jq \
    ffmpeg \
    openssh-server \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# Set default editor alternative to nano
RUN update-alternatives --set editor /bin/nano 2>/dev/null || true
# Install uv & uvx (fast Python package / tool runner)
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh && \
    chmod 0755 /usr/local/bin/uv /usr/local/bin/uvx 2>/dev/null || true

# Install aqua (CLI package manager for GitHub releases) directly from GitHub release
RUN curl -sSfL https://github.com/aquaproj/aqua/releases/download/v2.66.0/aqua_linux_amd64.tar.gz | tar -xz -C /usr/local/bin aqua && \
    chmod 0755 /usr/local/bin/aqua

# Configure Git system-wide to trust all mounted directories.
RUN git config --system --add safe.directory '*'
WORKDIR /opt/gajae-app

# Copy package installation helper.
COPY scripts/install-github-app.py /usr/local/bin/install-github-app
RUN chmod +x /usr/local/bin/install-github-app

# Copy the application built from the selected fork revision. The companion
# download template is derived at build time from APP_REPOSITORY, so every
# fork's image points at its own GitHub Releases without manual configuration.
# Dependencies first, code second. Docker keeps each COPY as its own layer, so a
# redeploy after a code change transfers the small code layer and reuses the
# dependency layer, instead of pulling the whole ~700 MB tree every time.
COPY --from=app-build /opt/gajae-deps /opt/gajae-deps
COPY --from=app-build /opt/gajae-app /opt/gajae-app
# Node resolves the tree through this link; the app directory itself stays code-only.
RUN ln -sfn /opt/gajae-deps/node_modules /opt/gajae-app/node_modules

# Install global CLI wrapper for convenience.
RUN printf '#!/bin/sh\nexec node /opt/gajae-app/dist-server/server/cli.js "$@"\n' > /usr/local/bin/gajae-app && \
    chmod 0755 /usr/local/bin/gajae-app

# Create default mount points for persistent state.
RUN mkdir -p /data /data/bin /workspace /root/.gjc /var/run/sshd
# Default environment configuration
ENV PATH="/data/bin:/root/.local/share/aquaproj-aqua/bin:/usr/local/bin:$PATH" \
    EDITOR="nano" \
    VISUAL="nano" \
    UV_CACHE_DIR="/data/cache/uv" \
    PIP_CACHE_DIR="/data/cache/pip" \
    UV_LINK_MODE="copy" \
    AQUA_ROOT_DIR="/data/aqua" \
    NPM_CONFIG_CACHE="/data/cache/npm" \
    HOST=0.0.0.0 \
    SERVER_PORT=3001 \
    ALLOWED_HOSTS=* \
    DATABASE_PATH=/data/auth.db \
    WORKSPACES_ROOT=/workspace \
    GJC_WORKER_AGENT_DIR=/root/.gjc/agent \
    NODE_ENV=production \
    AUTO_UPDATE_PACKAGES=true \
    CHECK_PACKAGE_UPDATES=true \
    POST_COMMANDS="" \
    GAJAE_COMPANION_DOWNLOAD_TEMPLATE="" \
    INSTALL_GJC_CLI=true \
    SSH_ENABLE=false \
    SSH_PORT=2222 \
    SSH_ALLOW_PASSWORD=false \
    SSH_PASSWORD="" \
    SSH_PUBLIC_KEYS="" \
    SSH_NO_AUTH=false \
    SSH_DEFAULT_COMMAND=""
EXPOSE 3001 2222

VOLUME ["/data", "/workspace", "/root/.gjc"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["start"]
