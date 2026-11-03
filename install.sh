#!/usr/bin/env sh
set -eu

REPO="${ORCHIVOX_REPOSITORY:-MFathan7/orchivox-agent}"
LAUNCHER_URL="${ORCHIVOX_LAUNCHER_URL:-https://github.com/${REPO}/releases/latest/download/launcher.mjs}"

fail() {
  printf '%s\n' "orchivox: $*" >&2
  exit 1
}

need_node() {
  command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required. Install Node, then run this script again. https://nodejs.org"
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  case "$major" in
    ''|*[!0-9]*) fail "Node.js 20 or newer is required. Could not read the installed version." ;;
  esac
  if [ "$major" -lt 20 ]; then
    fail "Node.js 20 or newer is required. Found $(node --version 2>/dev/null || echo unknown)."
  fi
}

download() {
  url="$1"
  destination="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --retry-connrefused "$url" -o "$destination"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$destination" "$url"
  else
    fail "curl or wget is required to download the installer."
  fi
}

need_node
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t orchivox)
trap 'rm -rf "$tmp"' EXIT INT TERM

download "$LAUNCHER_URL" "$tmp/launcher.mjs" || fail "Could not download the launcher from $LAUNCHER_URL"
node "$tmp/launcher.mjs" install "$@"
