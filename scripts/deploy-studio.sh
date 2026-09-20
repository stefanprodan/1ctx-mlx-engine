#!/usr/bin/env bash
# Build mlx-spy, copy it to the Studio and let the binary reload its agent.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f scripts/studio.env ] || {
  echo "scripts/studio.env missing; copy studio.env.example" >&2
  exit 2
}
. scripts/studio.env
HOST=$STUDIO_SSH
ssh_() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"; }

make build
# Upload beside the live binary and rename: an interrupted copy must not
# leave launchd restarting a truncated executable.
scp -q bin/mlx-spy "$HOST:~/.mlx-spy/bin/mlx-spy.new"
ssh_ 'mv -f ~/.mlx-spy/bin/mlx-spy.new ~/.mlx-spy/bin/mlx-spy &&
  ~/.mlx-spy/bin/mlx-spy service install --restart \
  --engine http://127.0.0.1:11234 \
  --listen 0.0.0.0:11235 \
  --model-dir /Users/stefanprodan/models'
