#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts"
cd "$ROOT_DIR"

MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/spotify}"
BUN_BIN="${BUN_BIN:-/opt/homebrew/bin/bun}"
SKIP_BUILD=0
SKIP_INSTALL=0

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-mini.sh [options]

Builds the frontend, syncs the local music server to the Mac mini, installs
production dependencies, and restarts the launchd server.

Options:
  --skip-build          Reuse existing dist/.
  --skip-install        Sync files but do not run bun install or restart launchd.
  -h, --help            Show this help.

Environment:
  MINI_HOST             Explicit Mac mini SSH host.
  MINI_HOSTS            Fallback hosts. Default: m4mini-ts, Tailscale IP, m4mini.local, LAN IP.
  SSH_KEY               Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_APP            Default: /Users/hermes/Developer/spotify
  BUN_BIN               Default: /opt/homebrew/bin/bun
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

source "$SCRIPT_DIR/mini-host.sh"
resolve_mini_host

SSH_BASE=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout="${MINI_CONNECT_TIMEOUT:-10}")
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=${MINI_CONNECT_TIMEOUT:-10}"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  bun run build
fi

[[ -f dist/client/index.html ]] || { echo "Missing dist/client/index.html. Run without --skip-build first." >&2; exit 1; }

"${SSH_BASE[@]}" "$MINI_HOST" "mkdir -p '$REMOTE_APP/dist' '$REMOTE_APP/src/lib' '$REMOTE_APP/src/server' '$REMOTE_APP/src/types' '$REMOTE_APP/cache'"

rsync -a --delete -e "$RSYNC_SSH" dist/ "$MINI_HOST:$REMOTE_APP/dist/"
rsync -a --delete -e "$RSYNC_SSH" src/lib/ "$MINI_HOST:$REMOTE_APP/src/lib/"
rsync -a --delete -e "$RSYNC_SSH" src/server/ "$MINI_HOST:$REMOTE_APP/src/server/"
rsync -a --delete -e "$RSYNC_SSH" src/types/ "$MINI_HOST:$REMOTE_APP/src/types/"
rsync -a -e "$RSYNC_SSH" package.json bun.lock tsconfig.json "$MINI_HOST:$REMOTE_APP/"

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  "${SSH_BASE[@]}" "$MINI_HOST" "cd '$REMOTE_APP' && '$BUN_BIN' install --production --frozen-lockfile"
  "$ROOT_DIR/scripts/install-mini-server.sh"
  # The Mac mini shares one Caddy daemon with StreamArena. Re-merge Spotify's
  # marked host block on every deploy so a rebuilt shared config cannot leave
  # the native app with cached library data but no reachable streaming origin.
  "$ROOT_DIR/scripts/install-mini-caddy.sh"
  "$ROOT_DIR/scripts/check-mini.sh"
fi
