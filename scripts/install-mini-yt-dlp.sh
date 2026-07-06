#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MINI_HOST="${MINI_HOST:-}"
MINI_HOSTS="${MINI_HOSTS:-}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519_codex_m4mini}"
SERVICE_LABEL="${SERVICE_LABEL:-xyz.streamarena.spotify-ytdlp-update}"
# Weekly self-update. YouTube breaks extraction frequently; a stale yt-dlp is the
# usual cause of Smart Shuffle previews failing to resolve.
UPDATE_INTERVAL="${UPDATE_INTERVAL:-604800}"
YTDLP_URL="${YTDLP_URL:-https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos}"
INSTALL_DENO="${INSTALL_DENO:-0}"

usage() {
  cat <<'USAGE'
Usage: scripts/install-mini-yt-dlp.sh [options]

Installs the self-updating yt-dlp the Mac mini uses to stage YouTube Opus previews
for Smart Shuffle recommendations (the lossless resolver is reserved for the
Add-to-library path, so the library stays FLAC-only):
  - /Users/hermes/.local/bin/yt-dlp            (standalone macOS binary, `yt-dlp -U`)
  - /Users/hermes/.local/bin/spotify-ytdlp-update  (the weekly updater wrapper)
  - /Library/LaunchDaemons/xyz.streamarena.spotify-ytdlp-update.plist

local-music-server's ytDlpPath() probes ~/.local/bin FIRST, so this auto-updated
copy wins over any Homebrew yt-dlp. ffmpeg is already on the mini (used for
downloads/remux); the server passes --ffmpeg-location explicitly.

Options:
  --interval <seconds>   launchd StartInterval for self-update. Default: 604800 (weekly).
  --with-deno            Also `brew install deno` (optional; speeds yt-dlp's JS
                         challenge solving — anonymous extraction works without it).
  -h, --help             Show this help.

Environment:
  MINI_HOST              Explicit Mac mini SSH host.
  MINI_HOSTS             Fallback hosts. Default: m4mini-ts, Tailscale IP, m4mini.local, LAN IP.
  SSH_KEY                Default: ~/.ssh/id_ed25519_codex_m4mini
  SERVICE_LABEL          Default: xyz.streamarena.spotify-ytdlp-update
  YTDLP_URL              Standalone binary URL. Default: yt-dlp_macos latest release.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      [[ $# -ge 2 ]] || { echo "--interval requires a value" >&2; exit 2; }
      UPDATE_INTERVAL="$2"
      shift 2
      ;;
    --with-deno)
      INSTALL_DENO=1
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

ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$MINI_HOST" \
  "SERVICE_LABEL='$SERVICE_LABEL' UPDATE_INTERVAL='$UPDATE_INTERVAL' YTDLP_URL='$YTDLP_URL' INSTALL_DENO='$INSTALL_DENO' bash -s" <<'REMOTE'
set -euo pipefail

bin_dir="$HOME/.local/bin"
state_dir="$HOME/.local/state/spotify"
service_label="$SERVICE_LABEL"
plist="/Library/LaunchDaemons/$service_label.plist"
ytdlp="$bin_dir/yt-dlp"

mkdir -p "$bin_dir" "$state_dir"

echo "==> downloading yt-dlp standalone from $YTDLP_URL"
tmp_bin="$(mktemp)"
curl -fL --connect-timeout 10 --max-time 120 -o "$tmp_bin" "$YTDLP_URL"
install -m 755 "$tmp_bin" "$ytdlp"
rm -f "$tmp_bin"
echo "==> yt-dlp version: $("$ytdlp" --version)"

# Weekly self-update wrapper. `-U` rewrites the standalone binary in place; it runs
# as hermes (LaunchDaemon UserName) so it can write to ~/.local/bin.
cat > "$bin_dir/spotify-ytdlp-update" <<'SCRIPT'
#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/Users/hermes/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
before="$(/Users/hermes/.local/bin/yt-dlp --version 2>/dev/null || echo unknown)"
if /Users/hermes/.local/bin/yt-dlp -U 2>&1; then
  after="$(/Users/hermes/.local/bin/yt-dlp --version 2>/dev/null || echo unknown)"
  log "ytdlp_update ok before=$before after=$after"
else
  log "ytdlp_update failed (kept $before)"
  exit 1
fi
SCRIPT
chmod 755 "$bin_dir/spotify-ytdlp-update"
bash -n "$bin_dir/spotify-ytdlp-update"

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
    <string>/Users/hermes/.local/bin/spotify-ytdlp-update</string>
  </array>
  <key>UserName</key>
  <string>hermes</string>
  <key>GroupName</key>
  <string>staff</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>$UPDATE_INTERVAL</integer>
  <key>StandardOutPath</key>
  <string>/Users/hermes/.local/state/spotify/ytdlp-update.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/hermes/.local/state/spotify/ytdlp-update.err.log</string>
</dict>
</plist>
PLIST

sudo install -m 644 "$tmp_plist" "$plist"
rm -f "$tmp_plist"

sudo launchctl bootout system "$plist" 2>/dev/null || true
sudo launchctl bootstrap system "$plist"
sudo launchctl enable "system/$service_label" 2>/dev/null || true
sudo launchctl kickstart -k "system/$service_label"

if [[ "${INSTALL_DENO:-0}" == "1" ]]; then
  if command -v deno >/dev/null 2>&1; then
    echo "==> deno already installed: $(deno --version | head -1)"
  elif command -v brew >/dev/null 2>&1; then
    echo "==> installing deno (best-effort)"
    brew install deno || echo "WARN: deno install failed (anonymous extraction works without it)"
  else
    echo "WARN: brew not found; skipping deno (optional)"
  fi
fi

# Smoke test: anonymous flat search must return a video id (proves YouTube
# extraction works without cookies). Non-fatal — a transient network blip
# shouldn't fail the install.
echo "==> smoke test: anonymous search"
if "$ytdlp" --no-warnings --flat-playlist -J "ytsearch1:Real Deep Carry Me Higher" 2>/dev/null \
    | grep -q '"id"'; then
  echo "==> smoke test OK (anonymous extraction works)"
else
  echo "WARN: smoke test did not return a result — check network / yt-dlp on the mini"
fi

echo "==> done. server picks up $ytdlp via ytDlpPath() (~/.local/bin first)."
REMOTE
