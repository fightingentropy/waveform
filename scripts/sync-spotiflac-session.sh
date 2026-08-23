#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts"
MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
SESSION_FILE="${SPOTIFLAC_SESSION_FILE:-$HOME/.spotiflac/community_session.json}"
REMOTE_SESSION_DIR="${REMOTE_SPOTIFLAC_SESSION_DIR:-/Users/hermes/.spotiflac}"
REMOTE_SESSION_FILE="$REMOTE_SESSION_DIR/community_session.json"

[[ -f "$SESSION_FILE" ]] || {
  echo "Missing SpotiFLAC session: $SESSION_FILE" >&2
  exit 1
}

SESSION_FILE="$SESSION_FILE" bun -e '
  const file = process.env.SESSION_FILE;
  const value = JSON.parse(await Bun.file(file).text());
  const expiresAt = Date.parse(String(value.expires_at || value.expiresAt || ""));
  if (!value.session_id || !value.session_secret || !Number.isFinite(expiresAt)) {
    console.error("SpotiFLAC session is incomplete. Open SpotiFLAC and complete verification first.");
    process.exit(1);
  }
  if (expiresAt <= Date.now() + 30_000) {
    console.error("SpotiFLAC session is expired. Open SpotiFLAC and complete verification first.");
    process.exit(1);
  }
  console.log(`SpotiFLAC session is valid until ${new Date(expiresAt).toISOString()}`);
'

source "$SCRIPT_DIR/mini-host.sh"
resolve_mini_host

SSH_BASE=(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout="${MINI_CONNECT_TIMEOUT:-10}")
RSYNC_SSH="ssh -i $SSH_KEY -o BatchMode=yes -o ConnectTimeout=${MINI_CONNECT_TIMEOUT:-10}"
REMOTE_TEMP_FILE="$REMOTE_SESSION_FILE.tmp"

"${SSH_BASE[@]}" "$MINI_HOST" "mkdir -p '$REMOTE_SESSION_DIR' && chmod 700 '$REMOTE_SESSION_DIR'"
rsync -a -e "$RSYNC_SSH" "$SESSION_FILE" "$MINI_HOST:$REMOTE_TEMP_FILE"
"${SSH_BASE[@]}" "$MINI_HOST" "chmod 600 '$REMOTE_TEMP_FILE' && mv '$REMOTE_TEMP_FILE' '$REMOTE_SESSION_FILE'"

echo "Synced the refreshed SpotiFLAC session to the Mac mini."
