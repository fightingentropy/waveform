#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
REMOTE_APP="${REMOTE_APP:-/Users/hermes/Developer/spotify}"
PORT="${PORT:-5174}"
REMOTE_MUSIC_DIR="${REMOTE_MUSIC_DIR:-/Users/hermes/Music}"
SERVICE_LABEL="${SERVICE_LABEL:-xyz.streamarena.spotify-app}"

SSH_OPTS=(
  -i "$SSH_KEY"
  -o BatchMode=yes
  -o ConnectTimeout=10
)

source "$SCRIPT_DIR/mini-host.sh"
resolve_mini_host

fail=0

pass() {
  printf 'ok  %s\n' "$1"
}

bad() {
  printf 'bad %s\n' "$1" >&2
  fail=1
}

remote_output="$(ssh "${SSH_OPTS[@]}" "$MINI_HOST" \
  "REMOTE_APP='$REMOTE_APP' PORT='$PORT' REMOTE_MUSIC_DIR='$REMOTE_MUSIC_DIR' SERVICE_LABEL='$SERVICE_LABEL' bash -s" <<'REMOTE'
set -euo pipefail

app="$REMOTE_APP"
source_status=$(curl -sS -o /tmp/spotify-source.json -w "%{http_code}" --max-time 15 "http://127.0.0.1:$PORT/api/music/source" || true)
home_status=$(curl -sS -o /tmp/spotify-home.json -w "%{http_code}" --max-time 15 "http://127.0.0.1:$PORT/api/home" || true)
app_status=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:$PORT/" || true)
listener=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR == 2 {print $9}')
pid=$(pgrep -f "spotify-run-server|local-music-server.ts" | head -1 || true)
launch_output="$(launchctl print "system/$SERVICE_LABEL" 2>/dev/null || true)"
launch_pid=$(printf '%s\n' "$launch_output" | awk -F= '/pid =/ {gsub(/[ ";]/, "", $2); print $2; exit}')
launch_state=$(printf '%s\n' "$launch_output" | awk -F= '/state =/ {gsub(/[ ";]/, "", $2); print $2; exit}')
audio_files=$(find "$REMOTE_MUSIC_DIR" -type f \( -iname '*.aac' -o -iname '*.aif' -o -iname '*.aiff' -o -iname '*.flac' -o -iname '*.m4a' -o -iname '*.mp3' -o -iname '*.oga' -o -iname '*.ogg' -o -iname '*.opus' -o -iname '*.wav' \) | wc -l | tr -d ' ')
songs_count=$(python3 - <<'PY'
import json
try:
    print(json.load(open('/tmp/spotify-source.json')).get('songsCount', 'missing'))
except Exception:
    print('missing')
PY
)
lan_ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)

printf 'source_status=%s\n' "$source_status"
printf 'home_status=%s\n' "$home_status"
printf 'app_status=%s\n' "$app_status"
printf 'listener=%s\n' "${listener:-missing}"
printf 'pid=%s\n' "${pid:-missing}"
printf 'launch_pid=%s\n' "${launch_pid:-missing}"
printf 'launch_state=%s\n' "${launch_state:-missing}"
printf 'audio_files=%s\n' "$audio_files"
printf 'songs_count=%s\n' "$songs_count"
printf 'lan_ip=%s\n' "${lan_ip:-missing}"
REMOTE
)"

printf '%s\n' "$remote_output"

value_for() {
  printf '%s\n' "$remote_output" | awk -F= -v key="$1" '$1 == key {print substr($0, length(key) + 2); exit}'
}

source_status=$(value_for source_status)
home_status=$(value_for home_status)
app_status=$(value_for app_status)
listener=$(value_for listener)
pid=$(value_for pid)
launch_pid=$(value_for launch_pid)
launch_state=$(value_for launch_state)
audio_files=$(value_for audio_files)
songs_count=$(value_for songs_count)
lan_ip=$(value_for lan_ip)

[[ "$source_status" == "200" ]] && pass "source endpoint returns HTTP 200" || bad "source endpoint returned HTTP $source_status"
[[ "$home_status" == "200" ]] && pass "home API returns HTTP 200" || bad "home API returned HTTP $home_status"
[[ "$app_status" == "200" ]] && pass "frontend returns HTTP 200" || bad "frontend returned HTTP $app_status"
[[ "$listener" == *":$PORT" ]] && pass "server listens on port $PORT" || bad "listener is '$listener'"
if [[ "$pid" != "missing" ]]; then
  pass "server process is running ($pid)"
elif [[ "$launch_pid" != "missing" ]]; then
  pass "launchd reports server pid $launch_pid"
else
  bad "server process missing"
fi
[[ "$launch_state" == "running" ]] && pass "launchd state is running" || bad "launchd state is $launch_state"
[[ "$audio_files" =~ ^[0-9]+$ && "$audio_files" -gt 0 ]] && pass "remote music has $audio_files audio files" || bad "remote music has no audio files yet"
[[ "$songs_count" =~ ^[0-9]+$ && "$songs_count" -gt 0 ]] && pass "server scanned $songs_count songs" || bad "server scanned $songs_count songs"

DIRECT_HOST="${MINI_HOST_ADDRESS:-${MINI_HOST#*@}}"
direct_status="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 10 "http://$DIRECT_HOST:$PORT/api/music/source" || true)"
[[ "$direct_status" == "200" ]] && pass "direct URL http://$DIRECT_HOST:$PORT is reachable" || bad "direct URL returned HTTP $direct_status"

if [[ "$lan_ip" != "missing" && -n "$lan_ip" ]]; then
  pass "mini LAN IP is $lan_ip"
else
  bad "mini LAN IP could not be resolved"
fi

exit "$fail"
