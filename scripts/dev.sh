#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MUSIC_PORT="${MUSIC_PORT:-5176}"
music_pid=""

cleanup() {
  if [[ -n "$music_pid" ]] && kill -0 "$music_pid" 2>/dev/null; then
    kill "$music_pid" 2>/dev/null || true
    wait "$music_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

PORT="$MUSIC_PORT" bun run src/server/local-music-server.ts &
music_pid=$!

status="000"
for _ in 1 2 3 4 5 6 7 8; do
  if ! kill -0 "$music_pid" 2>/dev/null; then
    wait "$music_pid"
  fi
  status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$MUSIC_PORT/api/music/source" || true)"
  [[ "$status" == "200" ]] && break
  sleep 0.5
done

if [[ "$status" != "200" ]]; then
  echo "Local music service failed its health check on port $MUSIC_PORT" >&2
  exit 1
fi

exec bun run dev:web
