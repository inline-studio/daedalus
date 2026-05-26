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
# StrictModes is disabled in the generated ~/.ssh/config. Rationale:
#   - The host file is 0600 owned by the user that owns the daedalus install
#     (typically uid 1000).
#   - The agent container almost always runs as root (uid 0).
#   - StrictModes refuses keys not owned by the connecting user — it would
#     reject the host file as "owned by someone else."
#   - The check exists to stop another user on a multi-tenant box from
#     snooping/swapping your key. That threat doesn't apply: the key is
#     bind-mounted ro from a path we control into a container we spawned.
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

# Generated config — only if the agent hasn't placed its own. Disables
# StrictModes for the reason in the file header.
if [ ! -e "$HOME_SSH/config" ]; then
  cat > "$HOME_SSH/config" <<'SSH_EOF'
# Written by daedalus agent-turn.sh on container start.
# See runtime/setup-ssh.sh for why StrictModes is disabled.
Host *
  StrictModes no
SSH_EOF
  chmod 600 "$HOME_SSH/config" 2>/dev/null || true
fi
