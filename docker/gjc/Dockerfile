# Build from the repository root:
# docker build --file docker/gjc/Dockerfile --tag gajae-app-sandbox:gjc .
FROM docker/sandbox-templates:gajae-code

USER root
WORKDIR /opt/gajae-app
COPY --chown=agent:agent package.json LICENSE NOTICE ./
COPY --chown=agent:agent dist ./dist
COPY --chown=agent:agent dist-server ./dist-server
COPY --chown=agent:agent public ./public
COPY --chown=agent:agent shared ./shared
COPY --chown=agent:agent node_modules ./node_modules
COPY docker/shared/install-gajae-app.sh /tmp/install-gajae-app.sh
RUN chmod +x /tmp/install-gajae-app.sh && /tmp/install-gajae-app.sh /opt/gajae-app

# aqua resolves every package shim through this config. Without it the proxy
# cannot see the packages the installer registered and falls through to whatever
# else provides the name - `zoxide` ran apt's 0.4.3 copy while aqua had 0.10.0
# - or answers "command is not found" when nothing else does.
ENV AQUA_ROOT_DIR=/data/aqua \
    AQUA_CONFIG=/data/aqua/aqua.yaml

COPY --chown=agent:agent docker/shared/start-gajae-app.sh /home/agent/.gajae-app-start.sh
RUN printf '\n. /home/agent/.gajae-app-start.sh\n' >> /home/agent/.bashrc

USER agent
WORKDIR /home/agent
