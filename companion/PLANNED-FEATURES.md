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
