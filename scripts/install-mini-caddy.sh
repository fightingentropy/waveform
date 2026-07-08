#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
SPOTIFY_DOMAIN="${SPOTIFY_DOMAIN:-music.streamarena.xyz}"
SPOTIFY_WORKER_HOST="${SPOTIFY_WORKER_HOST:-spotify.erlinhoxha.workers.dev}"
SPOTIFY_UPSTREAM="${SPOTIFY_UPSTREAM:-127.0.0.1:5174}"
CADDYFILE="${CADDYFILE:-/Users/hermes/.config/caddy/Caddyfile}"
CADDY_BIN="${CADDY_BIN:-/usr/local/bin/caddy}"
CADDY_SERVICE_LABEL="${CADDY_SERVICE_LABEL:-xyz.streamarena.caddy}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-mini-caddy.sh [options]

Installs/updates the shared Mac mini Caddy route for direct Spotify streaming.

Options:
  --domain <host>        Public music host. Default: music.streamarena.xyz.
  --worker-host <host>   Worker backend host for auth/import APIs. Default: spotify.erlinhoxha.workers.dev.
  --upstream <host:port> Local Spotify server upstream. Default: 127.0.0.1:5174.
  -h, --help             Show this help.

Environment:
  MINI_HOST              Explicit Mac mini SSH host.
  MINI_HOSTS             Fallback hosts. Default: m4mini-ts, Tailscale IP, m4mini.local, LAN IP.
  SSH_KEY                Default: ~/.ssh/id_ed25519_codex_m4mini
  CADDYFILE              Default: /Users/hermes/.config/caddy/Caddyfile
  CADDY_BIN              Default: /usr/local/bin/caddy
  CADDY_SERVICE_LABEL    Default: xyz.streamarena.caddy

The script reads SPOTIFY_PROXY_TOKEN from /Users/hermes/.config/spotify/env on
the Mac mini and injects it only into the remote Caddyfile.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      [[ $# -ge 2 ]] || { echo "--domain requires a value" >&2; exit 2; }
      SPOTIFY_DOMAIN="$2"
      shift 2
      ;;
    --worker-host)
      [[ $# -ge 2 ]] || { echo "--worker-host requires a value" >&2; exit 2; }
      SPOTIFY_WORKER_HOST="$2"
      shift 2
      ;;
    --upstream)
      [[ $# -ge 2 ]] || { echo "--upstream requires a value" >&2; exit 2; }
      SPOTIFY_UPSTREAM="$2"
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
  "SPOTIFY_DOMAIN='$SPOTIFY_DOMAIN' SPOTIFY_WORKER_HOST='$SPOTIFY_WORKER_HOST' SPOTIFY_UPSTREAM='$SPOTIFY_UPSTREAM' CADDYFILE='$CADDYFILE' CADDY_BIN='$CADDY_BIN' CADDY_SERVICE_LABEL='$CADDY_SERVICE_LABEL' bash -s" <<'REMOTE'
set -euo pipefail

env_file="/Users/hermes/.config/spotify/env"
state_dir="/Users/hermes/.local/state/spotify"
mkdir -p "$state_dir" "$(dirname "$CADDYFILE")"

if [[ ! -x "$CADDY_BIN" ]]; then
  echo "Missing Caddy binary at $CADDY_BIN" >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  echo "Missing Spotify env file at $env_file" >&2
  exit 1
fi

proxy_token="$(
  awk -F= '$1 == "SPOTIFY_PROXY_TOKEN" {print substr($0, length($1) + 2); exit}' "$env_file"
)"

if [[ -z "$proxy_token" ]]; then
  echo "SPOTIFY_PROXY_TOKEN is empty in $env_file" >&2
  exit 1
fi

if [[ ! -f "$CADDYFILE" ]]; then
  sudo install -m 600 /dev/null "$CADDYFILE"
fi

tmp="$(mktemp)"
sudo python3 - "$CADDYFILE" "$tmp" "$SPOTIFY_DOMAIN" "$SPOTIFY_WORKER_HOST" "$SPOTIFY_UPSTREAM" "$proxy_token" <<'PY'
import re
import sys
from pathlib import Path

caddyfile, tmp, domain, worker_host, upstream, token = sys.argv[1:]
path = Path(caddyfile)
text = path.read_text() if path.exists() else "{\n\tadmin off\n\tauto_https disable_redirects\n}\n"

begin = "# BEGIN SPOTIFY DIRECT CADDY"
end = "# END SPOTIFY DIRECT CADDY"

def caddy_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

def remove_managed_block(source: str) -> str:
    pattern = re.compile(rf"\n?{re.escape(begin)}.*?{re.escape(end)}\n?", re.S)
    return pattern.sub("\n", source)

def remove_named_site_blocks(source: str, names: set[str]) -> str:
    lines = source.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        first = stripped.split("{", 1)[0].strip()
        hosts = {part.strip() for part in first.split(",")}
        if stripped.endswith("{") and hosts & names:
            depth = lines[i].count("{") - lines[i].count("}")
            i += 1
            while i < len(lines) and depth > 0:
                depth += lines[i].count("{") - lines[i].count("}")
                i += 1
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out).strip() + "\n"

text = remove_managed_block(text)
text = remove_named_site_blocks(text, {
    domain,
    f"http://{domain}",
    "spotify.streamarena.xyz",
    "http://spotify.streamarena.xyz",
    "https://spotify.streamarena.xyz",
})

quoted_token = caddy_quote(token)
quoted_worker = caddy_quote(worker_host)

block = f"""
{begin}
(spotify_local_public) {{
\treverse_proxy {upstream} {{
\t\theader_up -x-spotify-user-id
\t\theader_up -x-spotify-user-email
\t\theader_up -x-spotify-user-name
\t\theader_up x-spotify-proxy-token {quoted_token}
\t\tlb_try_duration 30s
\t\tlb_try_interval 250ms
\t\tflush_interval -1
\t}}
}}

(spotify_local_trusted) {{
\treverse_proxy {upstream} {{
\t\tlb_try_duration 30s
\t\tlb_try_interval 250ms
\t\tflush_interval -1
\t}}
}}

(spotify_local_static) {{
\treverse_proxy {upstream} {{
\t\tlb_try_duration 30s
\t\tlb_try_interval 250ms
\t}}
}}

(spotify_worker_backend) {{
\treverse_proxy https://{worker_host} {{
\t\theader_up Host {quoted_worker}
\t\tlb_try_duration 30s
\t\tlb_try_interval 250ms
\t}}
}}

http://{domain} {{
\tredir https://{domain}{{uri}} 308
}}

https://{domain} {{
\tencode zstd gzip

\t@trusted_spotify_proxy {{
\t\tpath /api/*
\t\theader x-spotify-proxy-token {quoted_token}
\t}}
\thandle @trusted_spotify_proxy {{
\t\timport spotify_local_trusted
\t}}

\t@direct_spotify_media {{
\t\tpath /api/files/local/* /api/artwork/local/*
\t}}
\thandle @direct_spotify_media {{
\t\timport spotify_local_public
\t}}

\t@spotify_api path /api/*
\thandle @spotify_api {{
\t\timport spotify_worker_backend
\t}}

\thandle {{
\t\timport spotify_local_static
\t}}

\tlog {{
\t\toutput file /Users/hermes/.local/state/spotify/caddy-access.log {{
\t\t\troll_size 10MiB
\t\t\troll_keep 10
\t\t\troll_keep_for 168h
\t\t}}
\t}}
}}
{end}
"""

def insert_after_global_options(source: str, managed: str) -> str:
    lines = source.rstrip().splitlines()
    if not lines:
        return managed.lstrip()

    first_nonempty = next((index for index, line in enumerate(lines) if line.strip()), None)
    if first_nonempty is None or lines[first_nonempty].strip() != "{":
        return managed.lstrip() + "\n" + source.lstrip()

    depth = 0
    insert_after = first_nonempty
    for index in range(first_nonempty, len(lines)):
        depth += lines[index].count("{") - lines[index].count("}")
        if depth == 0:
            insert_after = index + 1
            break

    before = "\n".join(lines[:insert_after]).rstrip()
    after = "\n".join(lines[insert_after:]).lstrip()
    return before + "\n\n" + managed.lstrip() + ("\n" + after if after else "")

Path(tmp).write_text(insert_after_global_options(text, block))
PY

sudo "$CADDY_BIN" validate --config "$tmp" --adapter caddyfile
backup="$CADDYFILE.$(date -u +%Y%m%dT%H%M%SZ).bak"
sudo cp "$CADDYFILE" "$backup"
sudo install -m 600 "$tmp" "$CADDYFILE"
rm -f "$tmp"

sudo launchctl kickstart -k "system/$CADDY_SERVICE_LABEL" 2>/dev/null || {
  plist="/Library/LaunchDaemons/$CADDY_SERVICE_LABEL.plist"
  sudo launchctl bootout system "$plist" 2>/dev/null || true
  sudo launchctl bootstrap system "$plist"
  sudo launchctl kickstart -k "system/$CADDY_SERVICE_LABEL"
}

printf 'caddyfile=%s\n' "$CADDYFILE"
printf 'backup=%s\n' "$backup"
sudo launchctl print "system/$CADDY_SERVICE_LABEL" 2>/dev/null | awk '/state =|pid =|last exit code =|path =/ {print}'
REMOTE
