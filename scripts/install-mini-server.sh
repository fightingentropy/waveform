#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/spotify}"
REMOTE_MUSIC_DIR="${REMOTE_MUSIC_DIR:-/Users/hermes/Music}"
PORT="${PORT:-5174}"
HOST="${HOST:-0.0.0.0}"
BUN_BIN="${BUN_BIN:-/opt/homebrew/bin/bun}"
PROXY_HOSTNAMES="${PROXY_HOSTNAMES:-spotify.streamarena.xyz}"
SERVICE_LABEL="${SERVICE_LABEL:-xyz.streamarena.spotify-app}"
LIBRARY_OWNER_EMAILS="${LIBRARY_OWNER_EMAILS:-${SPOTIFY_LIBRARY_OWNER_EMAILS:-}}"
LIBRARY_OWNER_USER_IDS="${LIBRARY_OWNER_USER_IDS:-${SPOTIFY_LIBRARY_OWNER_USER_IDS:-}}"
LIBRARY_OWNER_NAMES="${LIBRARY_OWNER_NAMES:-${SPOTIFY_LIBRARY_OWNER_NAMES:-Erlin}}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-mini-server.sh [options]

Installs/updates the Mac mini Spotify music server:
  - /Users/hermes/.local/bin/spotify-run-server
  - /Library/LaunchDaemons/xyz.streamarena.spotify-app.plist
  - /Users/hermes/.config/spotify/env

Options:
  --port <port>          Server port. Default: 5174.
  --host <host>          Bind host. Default: 0.0.0.0.
  --music-dir <path>     Remote music source. Default: /Users/hermes/Music.
  -h, --help             Show this help.

Environment:
  MINI_HOST              Explicit Mac mini SSH host.
  MINI_HOSTS             Fallback hosts. Default: m4mini-ts, Tailscale IP, m4mini.local, LAN IP.
  SSH_KEY                Default: ~/.ssh/id_ed25519_codex_m4mini
  REMOTE_APP             Default: /Users/hermes/Developer/spotify
  REMOTE_MUSIC_DIR       Default: /Users/hermes/Music
  BUN_BIN                Default: /opt/homebrew/bin/bun
  PROXY_HOSTNAMES        Default: spotify.streamarena.xyz
  LIBRARY_OWNER_EMAILS   Comma-separated account emails allowed to use the Mac mini library.
  LIBRARY_OWNER_USER_IDS Comma-separated account IDs allowed to use the Mac mini library.
  LIBRARY_OWNER_NAMES    Comma-separated display names allowed to use the Mac mini library. Default: Erlin.
  SERVICE_LABEL          Default: xyz.streamarena.spotify-app
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      [[ $# -ge 2 ]] || { echo "--port requires a value" >&2; exit 2; }
      PORT="$2"
      shift 2
      ;;
    --host)
      [[ $# -ge 2 ]] || { echo "--host requires a value" >&2; exit 2; }
      HOST="$2"
      shift 2
      ;;
    --music-dir)
      [[ $# -ge 2 ]] || { echo "--music-dir requires a path" >&2; exit 2; }
      REMOTE_MUSIC_DIR="$2"
      shift 2
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

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
  "REMOTE_APP='$REMOTE_APP' REMOTE_MUSIC_DIR='$REMOTE_MUSIC_DIR' PORT='$PORT' HOST='$HOST' BUN_BIN='$BUN_BIN' PROXY_HOSTNAMES='$PROXY_HOSTNAMES' LIBRARY_OWNER_EMAILS='$LIBRARY_OWNER_EMAILS' LIBRARY_OWNER_USER_IDS='$LIBRARY_OWNER_USER_IDS' LIBRARY_OWNER_NAMES='$LIBRARY_OWNER_NAMES' SERVICE_LABEL='$SERVICE_LABEL' bash -s" <<'REMOTE'
set -euo pipefail

state_dir="$HOME/.local/state/spotify"
bin_dir="$HOME/.local/bin"
config_dir="$HOME/.config/spotify"
env_file="$config_dir/env"
service_label="$SERVICE_LABEL"
app_plist="/Library/LaunchDaemons/$service_label.plist"

mkdir -p "$state_dir" "$bin_dir" "$config_dir" "$REMOTE_MUSIC_DIR" "$REMOTE_APP/cache"
chmod 700 "$state_dir" "$bin_dir" "$config_dir"

if [[ ! -x "$BUN_BIN" ]]; then
  echo "Missing Bun runtime at $BUN_BIN" >&2
  exit 1
fi

if [[ ! -f "$REMOTE_APP/src/server/local-music-server.ts" ]]; then
  echo "Missing server source: $REMOTE_APP/src/server/local-music-server.ts" >&2
  exit 1
fi

if [[ ! -f "$REMOTE_APP/src/lib/licensed-source-download.ts" ]]; then
  echo "Missing shared library source: $REMOTE_APP/src/lib/licensed-source-download.ts" >&2
  exit 1
fi

if [[ ! -f "$REMOTE_APP/dist/client/index.html" ]]; then
  echo "Missing frontend build: $REMOTE_APP/dist/client/index.html" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  cat > "$env_file" <<ENV
HOST=$HOST
PORT=$PORT
SPOTIFY_MUSIC_DIR=$REMOTE_MUSIC_DIR
SPOTIFY_DIST_DIR=$REMOTE_APP/dist/client
SPOTIFY_CACHE_DIR=$REMOTE_APP/cache
ENV
  chmod 600 "$env_file"
fi

set_env_var() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -F= -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $1 == key { print key "=" value; done = 1; next }
    { print }
    END { if (!done) print key "=" value }
  ' "$env_file" > "$tmp"
  install -m 600 "$tmp" "$env_file"
  rm -f "$tmp"
}

set_env_var HOST "$HOST"
set_env_var PORT "$PORT"
set_env_var SPOTIFY_MUSIC_DIR "$REMOTE_MUSIC_DIR"
set_env_var SPOTIFY_DIST_DIR "$REMOTE_APP/dist/client"
set_env_var SPOTIFY_CACHE_DIR "$REMOTE_APP/cache"
set_env_var SPOTIFY_PROXY_HOSTNAMES "$PROXY_HOSTNAMES"
set_env_var SPOTIFY_LIBRARY_OWNER_EMAILS "$LIBRARY_OWNER_EMAILS"
set_env_var SPOTIFY_LIBRARY_OWNER_USER_IDS "$LIBRARY_OWNER_USER_IDS"
set_env_var SPOTIFY_LIBRARY_OWNER_NAMES "$LIBRARY_OWNER_NAMES"

cat > "$bin_dir/spotify-run-server" <<'SCRIPT'
#!/bin/bash
set -uo pipefail

export PATH="/opt/homebrew/bin:/Users/hermes/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export SPOTIFY_ENV_FILE="${SPOTIFY_ENV_FILE:-/Users/hermes/.config/spotify/env}"
cd /Users/hermes/Developer/spotify

if [[ -f "$SPOTIFY_ENV_FILE" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "${line//[[:space:]]/}" || "$line" == \#* || "$line" != *=* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    if [[ "$value" == \"*\" && "$value" == *\" && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' && ${#value} -ge 2 ]]; then
      value="${value:1:${#value}-2}"
    fi

    export "$key=$value"
  done < "$SPOTIFY_ENV_FILE"
fi

printf '%s spotify server starting music=%s port=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SPOTIFY_MUSIC_DIR:-}" "${PORT:-}" >&2
exec /opt/homebrew/bin/bun src/server/local-music-server.ts
SCRIPT
chmod 700 "$bin_dir/spotify-run-server"
bash -n "$bin_dir/spotify-run-server"

tmp_plist="$(mktemp)"
cat > "$tmp_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$service_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/hermes/.local/bin/spotify-run-server</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/hermes/Developer/spotify</string>
  <key>UserName</key>
  <string>hermes</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/spotify/server.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/spotify/server.err.log</string>
</dict>
</plist>
PLIST

sudo install -m 644 "$tmp_plist" "$app_plist"
rm -f "$tmp_plist"

sudo launchctl bootout system "$app_plist" 2>/dev/null || true
listener_pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
parent_pids=""
for pid in $listener_pids; do
  parent=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
  if [[ -n "$parent" && "$parent" != "1" ]]; then
    parent_pids="$parent_pids $parent"
  fi
done
targets=$(printf '%s\n' $listener_pids $parent_pids | awk 'NF && !seen[$1]++')
if [[ -n "$targets" ]]; then
  kill $targets 2>/dev/null || true
  sleep 2
fi
remaining_pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
if [[ -n "$remaining_pids" ]]; then
  kill -9 $remaining_pids 2>/dev/null || true
  sleep 1
fi

sudo launchctl enable "system/$service_label" 2>/dev/null || true
sudo launchctl bootstrap system "$app_plist"
sudo launchctl enable "system/$service_label" 2>/dev/null || true

status="000"
for attempt in $(seq 1 8); do
  status=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 15 "http://127.0.0.1:$PORT/api/music/source" || true)
  [[ "$status" == "200" ]] && break
  sleep 3
done
printf 'server_http=%s\n' "$status"
launchctl print "system/$service_label" 2>/dev/null | awk '/state =|pid =|runs =|last exit code =|path =/ {print}'

[[ "$status" == "200" ]] || exit 1
REMOTE
