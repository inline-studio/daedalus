# Daedalus base image. One image, two roles:
#   - SUPERVISOR: runs `dae serve` (the long-lived listener / scheduler)
#   - AGENT TURN: runs `dae agent-turn` (a single agent turn; spawned per-message)
#
# Agents may declare their own image in their manifest (`container.image`) for richer
# toolchains; this image is the minimum needed to run daedalus itself plus a handful
# of common tools (bash, git, curl, ca-certs) so simple agents work out of the box.
FROM node:24-slim

# Base tooling agents will reach for in `bash` and for reaching out via the network.
# This image is ALSO the warm agent-bash runtime: with runtime.persistentAgent, the
# top-level agent's bash runs in the dae-worker (this image) via HostRuntime, and
# per-message subagents run their bash in this image too — so it needs a usable
# foundation, not just the supervisor minimum. (Per-language toolchains like python/php
# still live in per-agent images.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl wget \
    git \
    jq \
    less procps iproute2 iputils-ping \
    openssh-client rsync \
    bind9-dnsutils netcat-openbsd \
    ripgrep file \
    unzip zip xz-utils bzip2 \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Built-in UTF-8 locale (glibc ships C.UTF-8 — no `locales` package needed). Avoids the
# POSIX/C default that trips up Python/Node/CLIs on non-ASCII input.
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

# Docker CLI (client only — NOT the daemon). The supervisor (`dae serve`) spawns one
# container per agent turn by shelling out to `docker run` over the bind-mounted
# /var/run/docker.sock, so the `docker` binary MUST exist in this image — without it
# the dispatcher's execa("docker", …) fails to spawn and every turn dies as
# "agent container … exited undefined". Use the static client binary: it's tiny, arch
# -aware, and avoids depending on Docker's apt repo carrying this debian release.
ARG DOCKER_CLI_VERSION=27.5.1
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) darch=x86_64 ;; \
      arm64) darch=aarch64 ;; \
      *) echo "unsupported arch for docker cli: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${darch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz; \
    tar -xzf /tmp/docker.tgz -C /tmp; \
    install -m 0755 /tmp/docker/docker /usr/local/bin/docker; \
    rm -rf /tmp/docker /tmp/docker.tgz; \
    docker --version

# Chromium runtime libraries, so browser-automation skills (agent-browser via
# Playwright/Puppeteer) can LAUNCH the Chromium they install at runtime. Stateful
# browser CLIs must run in a PERSISTENT shell — i.e. the agent's bash via HostRuntime,
# which executes in THIS image (the dae-worker for top-level agents; the per-message
# container for subagents). A per-call `container.image` would spawn a throwaway
# container per command and kill the browser between `open` and `snapshot`, so the libs
# belong here, not only in the per-toolchain leaves. Node is already present, so we use
# Playwright's own installer for the exact, version-correct package set.
ARG PLAYWRIGHT_VERSION=1.49.1
RUN npx --yes "playwright@${PLAYWRIGHT_VERSION}" install-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Use tini as PID 1 so signals propagate cleanly and zombies get reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]

WORKDIR /app

# Install daedalus. `dae install` packs the EXACT installed CLI into the build
# context (daedalus-<version>.tgz) so the image always matches your `dae` version
# — no dependency on what's been released. The COPY is tolerant: docker-compose.yml
# is always present as the anchor, and daedalus-*.tg[z] is an optional glob, so a
# build context without the tarball still works and falls back to the published
# release.
ARG DAEDALUS_VERSION=latest
COPY docker-compose.yml daedalus-*.tg[z] /tmp/dae/
RUN if ls /tmp/dae/daedalus-*.tgz >/dev/null 2>&1; then \
      npm install -g /tmp/dae/daedalus-*.tgz; \
    else \
      npm install -g "daedalus@$DAEDALUS_VERSION" \
        || npm install -g "https://github.com/inline-studio/daedalus/releases/latest/download/daedalus-latest.tgz"; \
    fi \
    && rm -rf /tmp/dae \
    && npm cache clean --force

# A non-root user for the supervisor + agent processes. We deliberately don't switch
# to it here — the host's UID/GID get mapped in at `docker run --user` time so
# bind-mounted brain / shared paths line up with host ownership.
# node:24-slim already ships a `node` user at uid 1000, so create `dae` with
# --non-unique (it shares uid 1000); ownership of /shared + /data is what matters
# (named volumes inherit it, so the uid-1000 runtime user can write).
RUN useradd --create-home --shell /bin/bash --non-unique --uid 1000 dae \
    && mkdir -p /brain /shared /data \
    && chown -R 1000 /home/dae /shared /data

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
    && cp -RL "$DAE_PKG" /dae-runtime/daedalus

# Entrypoint shim + sourced setup scripts. Real files (not an inline printf)
# so they're testable on the host — see scripts/smoke-agent-shim.mjs.
COPY runtime/agent-turn.sh /dae-runtime/agent-turn.sh
COPY runtime/setup-ssh.sh /dae-runtime/setup-ssh.sh
RUN chmod +x /dae-runtime/agent-turn.sh /dae-runtime/setup-ssh.sh \
    && chmod -R a+rX /dae-runtime

# Sensible defaults — overridden by docker-compose / `docker run -e`.
# BRAIN_PATH / DAE_DATA_DIR / DAE_SHARED_DIR point the (otherwise host-relative)
# config at the conventional in-container mount points, so one config file works
# unchanged for host-side commands (`dae install`) and inside this container (`dae serve`).
ENV DAE_CONFIG=/etc/daedalus/config.yaml \
    BRAIN_PATH=/brain \
    DAE_DATA_DIR=/data \
    DAE_SHARED_DIR=/shared \
    NODE_ENV=production

VOLUME ["/brain", "/shared", "/data"]

CMD ["dae", "serve"]
