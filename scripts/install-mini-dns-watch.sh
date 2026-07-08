#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
SPOTIFY_DOMAIN="${SPOTIFY_DOMAIN:-music.streamarena.xyz}"
DNS_WATCH_INTERVAL="${DNS_WATCH_INTERVAL:-300}"
SERVICE_LABEL="${SERVICE_LABEL:-xyz.streamarena.spotify-dns-watch}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-mini-dns-watch.sh [options]

Installs/updates the Mac mini DNS drift watcher:
  - /Users/hermes/.local/bin/spotify-dns-watch
  - /Library/LaunchDaemons/xyz.streamarena.spotify-dns-watch.plist
  - /Users/hermes/.config/spotify/env

Options:
  --domain <host>        DNS name to watch. Default: music.streamarena.xyz.
  --interval <seconds>   launchd StartInterval. Default: 300.
  -h, --help             Show this help.

Environment:
  MINI_HOST              Explicit Mac mini SSH host.
  MINI_HOSTS             Fallback hosts. Default: m4mini-ts, Tailscale IP, m4mini.local, LAN IP.
  SSH_KEY                Default: ~/.ssh/id_ed25519_codex_m4mini
  DNS_WATCH_INTERVAL     Default: 300.
  SERVICE_LABEL          Default: xyz.streamarena.spotify-dns-watch

This service detects drift by comparing the public home IP with public DNS. It
logs mismatches rather than mutating DNS.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      [[ $# -ge 2 ]] || { echo "--domain requires a value" >&2; exit 2; }
      SPOTIFY_DOMAIN="$2"
      shift 2
      ;;
    --interval)
      [[ $# -ge 2 ]] || { echo "--interval requires a value" >&2; exit 2; }
      DNS_WATCH_INTERVAL="$2"
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
  "SPOTIFY_DOMAIN='$SPOTIFY_DOMAIN' DNS_WATCH_INTERVAL='$DNS_WATCH_INTERVAL' SERVICE_LABEL='$SERVICE_LABEL' bash -s" <<'REMOTE'
set -euo pipefail

state_dir="$HOME/.local/state/spotify"
bin_dir="$HOME/.local/bin"
config_dir="$HOME/.config/spotify"
env_file="$config_dir/env"
service_label="$SERVICE_LABEL"
plist="/Library/LaunchDaemons/$service_label.plist"

mkdir -p "$state_dir" "$bin_dir" "$config_dir"
chmod 700 "$state_dir" "$bin_dir" "$config_dir"
touch "$env_file"
chmod 600 "$env_file"

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

set_env_var SPOTIFY_DNS_WATCH_NAME "$SPOTIFY_DOMAIN"

cat > "$bin_dir/spotify-dns-watch" <<'SCRIPT'
#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/Users/hermes/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
ENV_FILE="${SPOTIFY_ENV_FILE:-/Users/hermes/.config/spotify/env}"
STATE_DIR="/Users/hermes/.local/state/spotify"
mkdir -p "$STATE_DIR"

if [[ -f "$ENV_FILE" ]]; then
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
  done < "$ENV_FILE"
fi

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

is_public_ipv4() {
  local ip="$1"
  [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  python3 - "$ip" <<'PY'
import ipaddress
import sys
try:
    ip = ipaddress.ip_address(sys.argv[1])
except ValueError:
    sys.exit(1)
sys.exit(0 if ip.version == 4 and ip.is_global else 1)
PY
}

detect_public_ip() {
  local ip
  ip="$(curl -fsS --connect-timeout 5 --max-time 10 https://api.ipify.org 2>/dev/null || true)"
  if is_public_ipv4 "$ip"; then
    printf '%s\n' "$ip"
    return 0
  fi

  ip="$(
    curl -fsS --connect-timeout 5 --max-time 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null \
      | awk -F= '$1 == "ip" {print $2; exit}' || true
  )"
  if is_public_ipv4 "$ip"; then
    printf '%s\n' "$ip"
    return 0
  fi

  return 1
}

validate_origin_ip() {
  local name="$1"
  local ip="$2"
  local status
  status="$(
    curl -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 5 \
      --max-time 12 \
      --resolve "$name:443:$ip" \
      "https://$name/" || true
  )"
  [[ "$status" == "200" ]]
}

name="${SPOTIFY_DNS_WATCH_NAME:-music.streamarena.xyz}"

candidate_ip="$(detect_public_ip || true)"
if [[ -z "$candidate_ip" ]]; then
  log "public_ip_detect_failed name=$name"
  exit 1
fi

if ! validate_origin_ip "$name" "$candidate_ip"; then
  log "candidate_validation_failed name=$name ip=$candidate_ip"
  exit 1
fi

dns_ip="$(dig +short "$name" A @1.1.1.1 | awk 'NF {last=$1} END {print last}')"
if [[ "$dns_ip" == "$candidate_ip" ]]; then
  log "dns_ok name=$name ip=$candidate_ip"
  exit 0
fi

log "dns_mismatch name=$name dns=${dns_ip:-none} public=$candidate_ip"
exit 2
SCRIPT
chmod 700 "$bin_dir/spotify-dns-watch"
bash -n "$bin_dir/spotify-dns-watch"

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
    <string>/Users/hermes/.local/bin/spotify-dns-watch</string>
  </array>
  <key>UserName</key>
  <string>hermes</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$DNS_WATCH_INTERVAL</integer>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/spotify/dns-watch.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/spotify/dns-watch.err.log</string>
</dict>
</plist>
PLIST

sudo install -m 644 "$tmp_plist" "$plist"
rm -f "$tmp_plist"

sudo launchctl bootout system "$plist" 2>/dev/null || true
sudo launchctl bootstrap system "$plist"
sudo launchctl enable "system/$service_label" 2>/dev/null || true
sudo launchctl kickstart -k "system/$service_label"
sleep 3

launchctl print "system/$service_label" 2>/dev/null | awk '/state =|pid =|last exit code =|path =/ {print}'
tail -n 20 "$state_dir/dns-watch.log" "$state_dir/dns-watch.err.log" 2>/dev/null || true
REMOTE
