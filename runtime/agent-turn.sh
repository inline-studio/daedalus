#!/bin/sh
# Injected agent-container entrypoint. The supervisor mounts this dir as
# /dae-runtime (ro), overrides the agent image's ENTRYPOINT to point here, and
# this shim runs daedalus through the bundled Node + dist — independent of
# whatever the agent's own image happens to have installed.
#
# Anything that needs to happen exactly once per agent turn on container start
# goes here, BEFORE the exec. Keep it shell-portable (#!/bin/sh, no bashisms);
# agent images range from debian to fedora to almalinux.

set -e

# Surface host-mounted SSH keys into $HOME/.ssh, if any. No-op when the
# operator hasn't placed a key. See setup-ssh.sh for rationale.
. /dae-runtime/setup-ssh.sh

exec /dae-runtime/node /dae-runtime/daedalus/dist/index.js "$@"
