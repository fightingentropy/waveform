#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${1:-${BUN_BIN:-/opt/homebrew/bin/bun}}"
BUN_DIR="$(dirname "$BUN_BIN")"

[[ -x "$BUN_BIN" ]] || { echo "Missing Bun runtime: $BUN_BIN" >&2; exit 1; }
export PATH="$BUN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$ROOT_DIR"
exec "$BUN_BIN" run scripts/maintain-spotiflac-session.ts
