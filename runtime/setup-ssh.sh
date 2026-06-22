#!/bin/sh
# Surface host-mounted SSH keys to the agent.
#
# Source this from agent-turn.sh. It's split out so the smoke can drive it
# without the entrypoint's trailing `exec /dae-runtime/node …`.
#
# The supervisor mounts the host's daedalus config dir at /etc/daedalus (ro).
# If the operator has placed key material under <configDir>/ssh/ on the host,
# it lands at /etc/daedalus/ssh/ inside the container. This script symlinks
# every file in there into $HOME/.ssh/ so git/ssh/scp/rsync find it via the
# usual lookup paths.
#
# The generated ~/.ssh/config sets StrictHostKeyChecking=accept-new. Rationale:
#   - A fresh per-turn container has no TTY, so the interactive "authenticity of
#     host can't be established (yes/no)?" prompt has no one to answer it — the
#     connection just fails. accept-new trusts a host the first time it's seen and
#     records it, while still refusing a host whose key later CHANGES (MITM).
#   - The operator's known_hosts (if mounted) is symlinked in below, so known
#     hosts like github.com never even reach the prompt; accept-new only covers
#     first contact with hosts not in that file.
#
# NOTE: do NOT add StrictModes here. It is an *sshd* (server) directive and is not
# a valid ssh *client* keyword — ssh rejects the whole config with "Bad
# configuration option" and then ignores the keys + known_hosts entirely, which
# silently breaks every git push/clone. (A private key with too-open permissions is
# a separate, client-side check that no config option disables — fix it with file
# perms, not config.)
#
# Idempotent: re-runs are no-ops. If the agent (or a previous turn) has
# already placed its own file at $HOME/.ssh/<name>, we leave it alone — the
# agent's own config wins.

# Resolve $DAE_SSH_HOST_DIR (test override) → default /etc/daedalus/ssh.
DAE_SSH_HOST_DIR="${DAE_SSH_HOST_DIR:-/etc/daedalus/ssh}"

# No keys mounted? Nothing to do — the operator hasn't opted in.
[ -d "$DAE_SSH_HOST_DIR" ] || return 0 2>/dev/null || exit 0

HOME_SSH="${HOME:-/root}/.ssh"
mkdir -p "$HOME_SSH" 2>/dev/null || true
chmod 700 "$HOME_SSH" 2>/dev/null || true

# Symlink each key/known_hosts/etc. into HOME. Skip names the agent has
# already placed — never shadow agent-written config.
for f in "$DAE_SSH_HOST_DIR"/*; do
  # Empty dir: the literal pattern survives expansion. -e filters it out.
  [ -e "$f" ] || continue
  name=$(basename "$f")
  if [ -e "$HOME_SSH/$name" ] || [ -L "$HOME_SSH/$name" ]; then
    # Already present (or broken symlink we placed earlier) — leave it.
    continue
  fi
  ln -sfn "$f" "$HOME_SSH/$name" 2>/dev/null || true
done

# Generated config — only if the agent hasn't placed its own. Sets
# StrictHostKeyChecking=accept-new so a TTY-less container can reach a host on
# first contact without an unanswerable yes/no prompt. See the file header.
if [ ! -e "$HOME_SSH/config" ]; then
  cat > "$HOME_SSH/config" <<'SSH_EOF'
# Written by daedalus agent-turn.sh on container start.
# See runtime/setup-ssh.sh for rationale. Client keywords only.
Host *
  StrictHostKeyChecking accept-new
SSH_EOF
  chmod 600 "$HOME_SSH/config" 2>/dev/null || true
fi
