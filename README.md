# Spotify

Spotify is a Vite React music app served directly from the Mac mini through
Caddy. Cloudflare Workers are still available on `workers.dev` for lightweight
auth/import API work, but the public app and FLAC media stream through the home
Caddy path.

## Current Production Setup

- Public app: `https://spotify.streamarena.xyz`
- Mac mini Tailscale app/server: `http://100.121.144.60:5174`
- Mac mini LAN app/server: `http://192.168.1.240:5174`
- Worker backend for auth/import APIs: `https://spotify.erlinhoxha.workers.dev`
- Mac mini music folder: `/Users/hermes/Music`
- Remote app folder on Mac mini: `/Users/hermes/Developer/spotify`
- Music server launchd service: `xyz.streamarena.spotify-app`
- Shared Caddy launchd service: `xyz.streamarena.caddy`
- DNS drift watcher launchd service: `xyz.streamarena.spotify-dns-watch`

`spotify.streamarena.xyz` should be a DNS-only record pointing at the home
public IP. Caddy terminates TLS, routes static assets and media directly to the
Mac mini server, and forwards auth/import API calls to the Worker backend.

## Architecture

```text
Phone/browser
  -> Caddy: spotify.streamarena.xyz
       -> static app and media ranges: 127.0.0.1:5174
       -> auth/import APIs: spotify.erlinhoxha.workers.dev
            -> Worker calls MAC_MINI_ORIGIN=https://spotify.streamarena.xyz
                 -> Caddy trusted proxy-token route
                      -> Mac mini local server on 127.0.0.1:5174
                           -> /Users/hermes/Music
```

Uploaded/imported music is stored on the Mac mini. R2 is still configured as a
fallback/legacy storage mode in the Worker, but direct Caddy is the production
media path.

## Data Flow

- Library load: app calls `/api/home`; Caddy forwards browser API requests to
  the Worker, and the Worker calls back through direct Caddy with the shared
  proxy token and user id.
- Audio streaming: song `audioUrl` values point at `/api/files/local/*`; Caddy
  routes those range requests directly to the Mac mini server so seeking stays
  off the Worker/Tunnel path.
- Artwork: local sidecar/embedded art is served first; missing art can be cached
  from online artwork lookup by the Mac mini server.
- Manual upload: browser posts to `/api/songs`; Worker requires auth, forwards
  the upload to the Mac mini, and the Mac mini saves it into `/Users/hermes/Music`.
- Spotify import: Worker resolves metadata/provider stream URLs, then calls the
  direct Caddy origin; the Mac mini downloads and stores the audio, cover,
  lyrics, and sidecar metadata.

## Important Runtime Notes

- Keep the Mac mini music server launchd service running:
  - `xyz.streamarena.spotify-app`
- Keep the shared Caddy launchd service running:
  - `xyz.streamarena.caddy`
- Keep the DNS drift watcher launchd service running:
  - `xyz.streamarena.spotify-dns-watch`
- Operational scripts try the Mac mini Tailscale SSH alias `m4mini-ts` first,
  then the raw Tailscale target `hermes@100.121.144.60`, then the LAN alias
  `m4mini.local`, then the raw Ethernet target `hermes@192.168.1.240`. Set
  `MINI_HOST` to force a single host, or `MINI_HOSTS` to override the fallback
  list.
- Public traffic should reach the Mac mini through the router's 80/443 port
  forwards and the direct DNS-only record for `spotify.streamarena.xyz`.
- `MAC_MINI_PROXY_TOKEN` is a Worker secret. Do not commit the real value.
- `SPOTIFY_PROXY_TOKEN` on the Mac mini must match the Worker secret.
- `SPOTIFY_LIBRARY_OWNER_EMAILS`, `SPOTIFY_LIBRARY_OWNER_USER_IDS`, or
  `SPOTIFY_LIBRARY_OWNER_NAMES` controls which app accounts can see and mutate
  the Mac mini music folder. This private deployment defaults owner names to
  `Erlin`; prefer setting the owner email or user id once known.
- The Mac mini DNS watcher compares public DNS against the current home IP and
  logs drift. It does not store a Cloudflare API token or mutate DNS.
- The Settings page intentionally only shows user-facing playback/download
  settings now. Source status, edit-mode toggles, and Spotify cookie UI were
  removed from normal app chrome.
- The client caches API responses in memory for a short window and dedupes
  in-flight fetches, so navigating between Home/Search/etc does not reload the
  full song list every render. Uploads, imports, likes, sign-in, and sign-out
  invalidate the cache.

## Repository Structure

- `src/client/` - React app shell, routes, auth provider, shared API cache.
- `src/components/` - reusable UI, player bar, song list/grid, upload controls.
- `src/store/` - Zustand stores for player state, likes, and older browser-local
  library helpers.
- `src/worker/index.ts` - Cloudflare Worker API, auth, D1/R2 fallback paths,
  Spotify import helpers, and Mac mini proxy mode.
- `src/server/local-music-server.ts` - Bun server deployed to the Mac mini. It
  scans the music folder, serves media with range support, accepts uploads, and
  writes `.spotify.json` sidecars.
- `scripts/deploy-mini.sh` - builds/syncs the app and local server to Mac mini.
- `scripts/mini-host.sh` - shared Mac mini SSH host resolver with Tailscale then
  LAN fallback.
- `scripts/install-mini-server.sh` - installs/restarts the Mac mini launchd app
  service.
- `scripts/install-mini-caddy.sh` - installs/updates the direct Caddy route for
  `spotify.streamarena.xyz`.
- `scripts/install-mini-dns-watch.sh` - installs/updates the DNS drift watcher
  for the direct home Caddy hostname.
- `scripts/sync-mini-music.sh` - syncs audio/artwork/lyrics/sidecars to
  `/Users/hermes/Music`.
- `scripts/check-mini.sh` - health check for Mac mini server, launchd, library
  scan count, and direct Mini reachability.
- `wrangler.jsonc` - Cloudflare Worker bindings, `workers.dev` backend, and
  `MAC_MINI_ORIGIN`.
- `FEATURES.md` - current user-facing features and production capabilities.

## Local Development

```bash
bun install
bun run dev
```

Wrangler simulates the Worker bindings during local development. For the local
Mac mini-style server on this machine:

```bash
bun run build
SPOTIFY_MUSIC_DIR="$HOME/Music" bun run local:music
```

## Mac mini Operations

Deploy app/server updates to the Mac mini:

```bash
bun run mini:deploy
```

Reuse the current local `dist/` build:

```bash
bash scripts/deploy-mini.sh --skip-build
```

Check the Mac mini server:

```bash
bun run mini:check
```

Install/update the direct Caddy route:

```bash
bun run mini:install-caddy
```

Install/update the DNS drift watcher:

```bash
bun run mini:install-dns-watch
```

Sync music to the Mac mini:

```bash
bun run mini:sync-music
```

Sync music from a specific local folder:

```bash
bash scripts/sync-mini-music.sh --source /Users/erlinhoxha/Movies
```

The sync copies audio, cover, lyrics, and `.spotify.json` sidecar files. It does
not delete remote files.

The `mini:*` scripts try `m4mini-ts`, `hermes@100.121.144.60`,
`m4mini.local`, then `hermes@192.168.1.240`. Override with `MINI_HOST=...` for
one host or `MINI_HOSTS="host1 host2"` for a custom ordered list.

## Cloudflare Worker Deployment

Deploy the Worker backend:

```bash
bun run deploy
```

The active `wrangler.jsonc` contains:

```json
"workers_dev": true,
"MAC_MINI_ORIGIN": "https://spotify.streamarena.xyz"
```

Set or rotate the Worker secret:

```bash
wrangler secret put MAC_MINI_PROXY_TOKEN
```

Mac mini server env lives at `/Users/hermes/.config/spotify/env` and should
include:

```bash
HOST=0.0.0.0
PORT=5174
SPOTIFY_MUSIC_DIR=/Users/hermes/Music
SPOTIFY_DIST_DIR=/Users/hermes/Developer/spotify/dist/client
SPOTIFY_CACHE_DIR=/Users/hermes/Developer/spotify/cache
SPOTIFY_ARTWORK_LOOKUP=1
SPOTIFY_ARTWORK_COUNTRY=GB
SPOTIFY_PROXY_TOKEN=...
SPOTIFY_PROXY_HOSTNAMES=spotify.streamarena.xyz
SPOTIFY_LIBRARY_OWNER_EMAILS=
SPOTIFY_LIBRARY_OWNER_USER_IDS=
SPOTIFY_LIBRARY_OWNER_NAMES=Erlin
SPOTIFY_DNS_WATCH_NAME=spotify.streamarena.xyz
```

## Verification

Useful checks after deploy:

```bash
bun run typecheck
bun run lint
bun run build
bun run mini:check
bun run mini:install-caddy
bun run mini:install-dns-watch
curl -I https://spotify.streamarena.xyz
curl -sS -o /dev/null -w "%{http_code}\n" https://spotify.erlinhoxha.workers.dev/api/auth/session
```

Expected behavior:

- Direct Caddy app returns `200`.
- Worker backend is reachable on `workers.dev`.
- Audio range requests through Caddy return `206`.
- Direct Mac mini API requests without the proxy token return `401` on public
  hostnames.
- DNS watch logs show `dns_ok` in
  `/Users/hermes/.local/state/spotify/dns-watch.log`.
- Mac mini direct health check returns `200`.

## API Surface

- `GET /api/home`
- `GET /api/search-index`
- `GET /api/music/source`
- `GET /api/library`
- `GET /api/liked`
- `GET /api/playlist/:id`
- `POST /api/playlist/:id/reorder`
- `GET /api/songs`
- `POST /api/songs`
- `GET /api/songs/:id`
- `PATCH /api/songs/:id`
- `POST /api/songs/:id/assets`
- `POST /api/songs/spotify`
- `POST /api/songs/spotify/file`
- `POST /api/songs/spotify/batch`
- `GET /api/songs/spotify/cover`
- `GET /api/files/*`
- `GET /api/files/local/*`
- `GET /api/artwork/*`
- `GET /api/artwork/local/*`
- `GET /api/artwork/r2/*`
- `GET/POST/DELETE /api/likes`
- `POST /api/register`
- `GET /api/auth/session`
- `GET /api/auth/me`
- `POST /api/auth/signin`
- `POST /api/auth/signout`

## Scripts

- `bun run dev` - local Vite/Worker dev server.
- `bun run build` - production build for Worker and client assets.
- `bun run deploy` - build and deploy to Cloudflare.
- `bun run upload` - build and dry-run deploy.
- `bun run lint` - ESLint.
- `bun run local:music` - run the Bun local music server.
- `bun run mini:deploy` - deploy build/server to Mac mini.
- `bun run mini:install-server` - install Mac mini launchd app service.
- `bun run mini:install-caddy` - install direct Caddy route.
- `bun run mini:install-dns-watch` - install DNS drift watcher launchd service.
- `bun run mini:sync-music` - sync music files to Mac mini.
- `bun run mini:check` - verify Mac mini health.
- `bun run cf-typegen` - regenerate Cloudflare binding types.
