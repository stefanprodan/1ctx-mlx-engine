#!/usr/bin/env bash
# Install or upgrade 1ctx-mlx-engine:
#
#   curl -fsSL https://raw.githubusercontent.com/stefanprodan/1ctx-mlx-engine/main/scripts/install.sh | bash
#
# It downloads a release, verifies its checksum, puts the binary in
# ~/.1ctx-mlx-engine/bin and runs `service install --restart` with the
# arguments it was given (`| bash -s -- --listen 0.0.0.0:11235`). The path
# never changes, so an upgrade is the same command again. It needs no
# signing: curl sets no quarantine attribute, so Gatekeeper never assesses
# the file, and the linker's ad-hoc signature is all Apple Silicon asks
# for. It links nothing, edits no rc file and never uses sudo.
#
# Its own options are environment variables, so every argument belongs to
# `service install`:
#   VERSION       a tag such as v0.2.0-rc.1 (default: the latest stable
#                 release; the only way to get a pre-release)
#   INSTALL_DIR   where the binary goes (default: ~/.1ctx-mlx-engine/bin)
#   NO_SERVICE    1 stops after the binary is in place and verified
#   DOWNLOAD_URL  the directory that holds the two release assets, for the
#                 tests; VERSION is then required
set -euo pipefail

REPO=stefanprodan/1ctx-mlx-engine
NAME=1ctx-mlx-engine
ASSET=${NAME}_darwin_arm64.tar.gz
CHECKSUMS=${NAME}_checksums.txt

# The whole body is a function called on the last line, so a connection
# cut mid-download runs nothing.
main() {
  [ "$(uname -s)" = Darwin ] || fail "$NAME runs on macOS only."
  [ "$(uname -m)" = arm64 ] || fail "$NAME needs Apple Silicon."
  local os
  os=$(sw_vers -productVersion)
  [ "${os%%.*}" -ge 26 ] || fail "$NAME needs macOS 26 or later, this is $os."

  local version=${VERSION:-} base=${DOWNLOAD_URL:-}
  if [ -n "$base" ]; then
    [ -n "$version" ] || fail "DOWNLOAD_URL needs VERSION."
  else
    # a plain assignment, not an || list: errexit has to see latest fail
    if [ -z "$version" ]; then version=$(latest); fi
    base=https://github.com/$REPO/releases/download/$version
  fi
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$ ]] ||
    fail "$version is not a release tag."

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading $NAME $version"
  fetch "$base/$ASSET" "$tmp/$ASSET"
  fetch "$base/$CHECKSUMS" "$tmp/$CHECKSUMS"
  # only the archive's line: the file may list other assets one day
  grep -E "^[0-9a-f]{64}  $ASSET\$" "$tmp/$CHECKSUMS" >"$tmp/sum" ||
    fail "$CHECKSUMS has no entry for $ASSET."
  (cd "$tmp" && shasum -a 256 -c sum >/dev/null) ||
    fail "Checksum mismatch for $ASSET, nothing was installed."

  tar -xzf "$tmp/$ASSET" -C "$tmp" "$NAME"
  local reported
  reported=$("$tmp/$NAME" --version)
  [ "$reported" = "$version" ] ||
    fail "The binary reports $reported, expected $version."

  local dir=${INSTALL_DIR:-$HOME/.$NAME/bin}
  local bin=$dir/$NAME
  mkdir -p "$dir"
  # Copy beside the live binary and rename: the temp dir can be on another
  # volume, and launchd must never restart a truncated executable.
  cp "$tmp/$NAME" "$bin.new"
  chmod 0755 "$bin.new"
  mv -f "$bin.new" "$bin"

  if [ "${NO_SERVICE:-}" != 1 ]; then
    "$bin" service install --restart "$@"
  fi
  echo "Installed $bin"
}

# The tag behind releases/latest, read from the redirect: no API call and
# so no rate limit.
latest() {
  local url
  url=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
    "https://github.com/$REPO/releases/latest") ||
    fail "Could not reach github.com."
  case "$url" in
  */releases/tag/*) echo "${url##*/}" ;;
  *) fail "$REPO has no stable release yet; set VERSION." ;;
  esac
}

fetch() {
  curl -fsSL --proto '=https,file' --retry 3 -o "$2" "$1" ||
    fail "Download failed: $1"
}

fail() {
  echo "install.sh: $1" >&2
  exit 1
}

main "$@"
