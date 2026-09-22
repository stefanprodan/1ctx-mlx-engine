#!/usr/bin/env bash
# The staging instance: a Mac reached over ssh that runs mlx-serve and
# 1ctx-mlx-engine as launchd agents, with its data under ~/.1ctx-mlx-engine.
#
#   staging.sh deploy    build main, copy the binary, reinstall and restart
#   staging.sh status    what the service says
#
# The host is named in scripts/staging.env, never here.
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f scripts/staging.env ] || {
  echo "scripts/staging.env missing; copy scripts/staging.env.example" >&2
  exit 2
}
. scripts/staging.env
HOST=$STAGING_SSH
BIN='~/.1ctx-mlx-engine/bin/1ctx-mlx-engine'

# BatchMode fails fast instead of prompting
ssh_() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "$@"; }
fail() { echo "staging: $1" >&2; exit 1; }

deploy() {
  # Staging takes main only; another branch or uncommitted changes are
  # a deliberate bypass.
  local branch dirty sha version
  branch=$(git rev-parse --abbrev-ref HEAD)
  dirty=$(git status --porcelain)
  if [ "${ALLOW_BRANCH:-}" != 1 ]; then
    [ "$branch" = main ] || fail "on $branch, not main; ALLOW_BRANCH=1 deploys it anyway"
    [ -z "$dirty" ] || fail "the checkout has uncommitted changes"
  fi
  # The commit rides on the dev version, so the page names what staging
  # runs; a dirty tree names its diff too, so two deploys from one commit
  # are two versions.
  sha=$(git rev-parse --short HEAD)
  [ -z "$dirty" ] || sha=$sha.dirty$(git diff HEAD | shasum | cut -c1-6)
  version=v$(bun -e 'console.log(require("./package.json").version)')+$sha
  VERSION=$version make build
  [ "$(bin/1ctx-mlx-engine --version)" = "$version" ] || fail "the binary does not report $version"

  # Upload beside the live binary and rename: an interrupted copy must not
  # leave launchd restarting a truncated executable. A fresh staging has
  # no directory yet.
  ssh_ 'mkdir -p ~/.1ctx-mlx-engine/bin'
  scp -q bin/1ctx-mlx-engine "$HOST:~/.1ctx-mlx-engine/bin/1ctx-mlx-engine.new"
  ssh_ "mv -f $BIN.new $BIN &&
    $BIN service install --restart \
    --engine http://127.0.0.1:11234 \
    --listen 0.0.0.0:11235"
}

case ${1:-} in
  deploy) deploy ;;
  status) ssh_ "$BIN service status" ;;
  *) fail "usage: staging.sh deploy|status" ;;
esac
