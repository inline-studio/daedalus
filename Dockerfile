# Daedalus base image. One image, two roles:
#   - SUPERVISOR: runs `dae serve` (the long-lived listener / scheduler)
#   - AGENT TURN: runs `dae agent-turn` (a single agent turn; spawned per-message)
#
# Agents may declare their own image in their manifest (`container.image`) for richer
# toolchains; this image is the minimum needed to run daedalus itself plus a handful
# of common tools (bash, git, curl, ca-certs) so simple agents work out of the box.
FROM node:24-slim

# Base tooling agents will reach for in `bash` and for reaching out via the network.
# Anything heavier (python, php, chromium, …) belongs in a per-agent image — keep this
# one small.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    jq \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Use tini as PID 1 so signals propagate cleanly and zombies get reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]

WORKDIR /app

# Two installation modes:
#   1. Production: copy a pre-built tarball into the image (CI builds the tarball first).
#   2. Development: install daedalus from npm directly.
# We default to (2) for now; CI / release flows can override with build args.
ARG DAEDALUS_VERSION=latest
ARG DAEDALUS_TARBALL=
RUN if [ -n "$DAEDALUS_TARBALL" ]; then \
      npm install -g "$DAEDALUS_TARBALL"; \
    else \
      npm install -g "daedalus@$DAEDALUS_VERSION" \
        || npm install -g "https://github.com/inline-studio/daedalus/releases/latest/download/daedalus-latest.tgz"; \
    fi \
    && npm cache clean --force

# A non-root user for the supervisor + agent processes. We deliberately don't switch
# to it here — the host's UID/GID get mapped in at `docker run --user` time so
# bind-mounted brain / shared paths line up with host ownership.
RUN useradd --create-home --shell /bin/bash --uid 1000 dae \
    && mkdir -p /brain /shared /data \
    && chown -R dae:dae /home/dae /shared /data

# ─────────────────────────────────────────────────────────────────────────
# Injectable agent runtime
#
# Per-agent containers in docker mode don't need Node or daedalus pre-installed
# in their image — instead, the supervisor mounts /dae-runtime/ (this directory)
# into them and overrides the entrypoint so the agent turn runs through the
# bundled Node + daedalus rather than the image's own.
#
# Constraints:
#   - The Node binary here is glibc-linked (debian-based). It works in any
#     glibc-compatible image (debian, ubuntu, fedora, rhel, almalinux, …) but
#     NOT in musl-based images like alpine. Document this in docs/docker-mode.md.
#   - We resolve the npm-global location at build time so this keeps working
#     across Node + npm upgrades.
RUN mkdir -p /dae-runtime \
    && cp -L "$(command -v node)" /dae-runtime/node \
    && DAE_PKG="$(npm root -g)/daedalus" \
    && cp -RL "$DAE_PKG" /dae-runtime/daedalus \
    && printf '%s\n' \
         '#!/bin/sh' \
         '# Injected agent runtime — runs daedalus through the supervisor-provided' \
         '# Node + dist regardless of what the agent image has installed.' \
         'exec /dae-runtime/node /dae-runtime/daedalus/dist/index.js "$@"' \
       > /dae-runtime/agent-turn.sh \
    && chmod +x /dae-runtime/agent-turn.sh \
    && chmod -R a+rX /dae-runtime

# Sensible defaults — overridden by docker-compose / `docker run -e`.
# BRAIN_PATH / DAE_DATA_DIR / DAE_SHARED_DIR point the (otherwise host-relative)
# config at the conventional in-container mount points, so one config file works
# unchanged on the host (`dae run`) and inside this container (`dae serve`).
ENV DAE_CONFIG=/etc/daedalus/config.yaml \
    BRAIN_PATH=/brain \
    DAE_DATA_DIR=/data \
    DAE_SHARED_DIR=/shared \
    NODE_ENV=production

VOLUME ["/brain", "/shared", "/data"]

CMD ["dae", "serve"]
