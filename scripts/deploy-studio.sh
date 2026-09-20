#!/usr/bin/env bash
# Build 1ctx-mlx-engine, copy it to the Studio and let the binary reload its
# agent.
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
# a Studio that starts fresh has no directory yet
ssh_ 'mkdir -p ~/.1ctx-mlx-engine/bin'
scp -q bin/1ctx-mlx-engine "$HOST:~/.1ctx-mlx-engine/bin/1ctx-mlx-engine.new"
ssh_ 'mv -f ~/.1ctx-mlx-engine/bin/1ctx-mlx-engine.new ~/.1ctx-mlx-engine/bin/1ctx-mlx-engine &&
  ~/.1ctx-mlx-engine/bin/1ctx-mlx-engine service install --restart \
  --engine http://127.0.0.1:11234 \
  --listen 0.0.0.0:11235 \
  --model-dir /Users/stefanprodan/models'
