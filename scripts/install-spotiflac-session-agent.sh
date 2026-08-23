#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts"
SERVICE_LABEL="xyz.streamarena.spotify-spotiflac-session"
INTERVAL_SECONDS="${SPOTIFLAC_SESSION_CHECK_INTERVAL:-300}"
STATE_DIR="$HOME/.local/state/spotify"
SESSION_FILE="${SPOTIFLAC_SESSION_FILE:-$HOME/.spotiflac/community_session.json}"
PLIST_SOURCE="$SCRIPT_DIR/$SERVICE_LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      [[ $# -ge 2 && "$2" =~ ^[0-9]+$ && "$2" -ge 60 ]] || { echo "--interval requires at least 60 seconds" >&2; exit 2; }
      INTERVAL_SECONDS="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: scripts/install-spotiflac-session-agent.sh [--interval seconds]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

[[ -n "$BUN_BIN" && -x "$BUN_BIN" ]] || { echo "Could not find an executable Bun runtime" >&2; exit 1; }
plutil -lint "$PLIST_SOURCE" >/dev/null
mkdir -p "$HOME/Library/LaunchAgents" "$STATE_DIR"
chmod 700 "$STATE_DIR"

TEMP_PLIST="$(mktemp /tmp/spotify-spotiflac-session.XXXXXX.plist)"
trap 'rm -f "$TEMP_PLIST"' EXIT
cp "$PLIST_SOURCE" "$TEMP_PLIST"
plutil -replace ProgramArguments.1 -string "$SCRIPT_DIR/maintain-spotiflac-session.sh" "$TEMP_PLIST"
plutil -replace ProgramArguments.2 -string "$BUN_BIN" "$TEMP_PLIST"
plutil -replace WorkingDirectory -string "$ROOT_DIR" "$TEMP_PLIST"
plutil -replace StartInterval -integer "$INTERVAL_SECONDS" "$TEMP_PLIST"
plutil -replace WatchPaths.0 -string "$SESSION_FILE" "$TEMP_PLIST"
plutil -replace StandardOutPath -string "$STATE_DIR/spotiflac-session-agent.log" "$TEMP_PLIST"
plutil -replace StandardErrorPath -string "$STATE_DIR/spotiflac-session-agent.err.log" "$TEMP_PLIST"
plutil -lint "$TEMP_PLIST" >/dev/null
install -m 644 "$TEMP_PLIST" "$PLIST_DEST"

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN" "$PLIST_DEST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST_DEST"
launchctl enable "$DOMAIN/$SERVICE_LABEL" 2>/dev/null || true
launchctl kickstart -k "$DOMAIN/$SERVICE_LABEL"

echo "Installed automatic SpotiFLAC session maintenance every $INTERVAL_SECONDS seconds."
launchctl print "$DOMAIN/$SERVICE_LABEL" 2>/dev/null | awk '/path =|state =|runs =|last exit code =/ {print}'
