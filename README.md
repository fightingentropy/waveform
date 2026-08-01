# Music

Self-hosted personal music app with a React client, Cloudflare Worker APIs, an
optional private media server, and an Expo mobile client. Accounts must sign in
before accessing a library.

This is an independent, unofficial project. It is not affiliated with or
endorsed by Spotify AB. Use import and download features only for media you are
permitted to access and copy.

## Features

- Browse, search, like, queue, and organize a personal music library.
- Stream local media with byte-range support, artwork, lyrics, and sidecars.
- Import licensed or user-authorized media through authenticated APIs.
- Download tracks for offline playback in the native client.
- Run the UI and media service together, or split account APIs onto Cloudflare.
- Preserve legacy R2 media support while using a private host for large files.

See [FEATURES.md](FEATURES.md) for the current product-level feature list.

## Architecture

```text
browser or native client
  -> https://music.example.com
       -> static UI and media ranges: private media server
       -> authenticated account/import APIs: Cloudflare Worker
            -> signed request to the private media server when required
                 -> owner-controlled music directory
```

The Worker owns account, session, D1, import, and optional R2 behavior. The
private Bun server indexes local media, serves range requests, accepts bounded
uploads, and writes media sidecars. A reverse proxy is the only public entry
point to the private host.

Keep real addresses, usernames, filesystem paths, service labels, account IDs,
and network topology in a private operational runbook. Public examples in this
repository intentionally use placeholders.

## Security boundary

- Public-host API calls require an authenticated session. Worker-to-private-host
  calls use a 30-second HMAC envelope bound to method, target, nonce, expiry,
  and user context; captured envelopes cannot be replayed.
- Direct media paths require a separate user/scoped media signature with a
  one-hour validity window.
- Implicit local access is limited to a real loopback socket peer; untrusted
  forwarding and identity headers are removed.
- Owner access is matched against immutable account IDs or verified email
  addresses and fails closed when ownership is not configured.
- Canonical paths keep media operations inside configured roots and reject
  symlink escapes.
- Uploads and upstream responses have byte limits; media range parsing is
  validated and covered by tests.
- Request-signing and media-signing secrets are separate and must never be
  committed. The request secret is never forwarded as a bearer token.
- Set `SPOTIFY_TRUST_LOCAL_NETWORK=1` only if every device on that network is
  trusted as the library owner. Loopback health checks do not require it.

The operator is responsible for hardening the reverse proxy, private host,
backups, DNS, TLS, and provider credentials. Third-party providers may impose
terms, copyright, and rate-limit restrictions.

## Repository structure

- `src/client/` — React shell, routes, auth provider, and API cache.
- `src/components/` — player, lists, grids, and upload controls.
- `src/store/` — player, queue, likes, and local state.
- `src/worker/index.ts` — Cloudflare Worker API and provider integrations.
- `src/worker/mac-mini-proxy.ts` — private-origin routing and request signer.
- `src/server/local-music-server.ts` — private Bun media service.
- `src/server/proxy-auth.ts` — expiry, HMAC, identity, and replay verification.
- `src/lib/private-proxy-contract.ts` — shared signature/headers contract.
- `src/lib/http-range.ts` — shared browser/Worker byte-range validation.
- `tests/` — policy, range, upload, proxy, playback, and persistence tests.
- `mobile/` — Expo native client with its own locked dependencies.
- `db/d1-migrations/` — versioned D1 schema changes.
- `scripts/` — local development and private-host deployment helpers.
- `wrangler.jsonc` — Cloudflare bindings with placeholder-safe configuration.

## Local development

Requirements: Bun 1.3.10, Node 22 for the mobile client, and Wrangler.

```bash
bun install --frozen-lockfile
bun run dev
```

The development server listens on port 5174. To exercise the private media
service separately:

```bash
bun run build
SPOTIFY_MUSIC_DIR="$HOME/Music" bun run local:music
```

The media service listens on port 5176 by default.

## Mandatory verification

The required web/Worker gate is:

```bash
bun run check
```

It runs ESLint, strict type checking, the complete Bun test suite, and a
production build. Pull requests run it after a frozen install. Mobile CI uses a
frozen `npm ci` install and runs type checking, lint, and tests independently.

Useful focused commands:

```bash
bun run lint
bun run typecheck
bun test
bun run build
cd mobile && npm ci && npm run typecheck && npm run lint && npm test
```

## Private media-host deployment

Configure SSH aliases and host details outside the repository. The deployment
scripts accept `MINI_HOST` for one private alias or `MINI_HOSTS` for an ordered
list. Do not put raw usernames or network addresses in tracked files.

```bash
bun run mini:deploy
bun run mini:check
bun run mini:install-server
bun run mini:install-caddy
bun run mini:install-dns-watch
bun run mini:sync-music
```

A private host environment file should be owner-readable only and may contain:

```bash
HOST=127.0.0.1
PORT=5174
SPOTIFY_MUSIC_DIR=/srv/music
SPOTIFY_DIST_DIR=/opt/music-app/dist/client
SPOTIFY_CACHE_DIR=/var/lib/music-app/cache
SPOTIFY_REQUEST_SIGNING_SECRET=<random-request-secret>
SPOTIFY_MEDIA_SIGNING_SECRET=<different-random-media-secret>
SPOTIFY_PROXY_HOSTNAMES=music.example.com
SPOTIFY_TRUST_LOCAL_NETWORK=0
SPOTIFY_LIBRARY_OWNER_EMAILS=
SPOTIFY_LIBRARY_OWNER_USER_IDS=<immutable-account-id>
```

The reverse proxy should terminate TLS, forward authenticated API routes, and
serve the private media service without exposing its port directly. Deployment
health checks, real service labels, DNS records, and host paths belong in the
private runbook.

## Cloudflare deployment

Apply versioned D1 migrations before deploying code; production requests never
run schema DDL:

```bash
bun run db:migrate:remote
bun run deploy
```

Set `MAC_MINI_ORIGIN` to the hardened public reverse-proxy origin. Provision two
independent secrets without placing their values in configuration. Each Worker
secret must match only its same-purpose private-host secret:

```bash
wrangler secret put MAC_MINI_REQUEST_SIGNING_SECRET
wrangler secret put MAC_MINI_MEDIA_SIGNING_SECRET
wrangler secret put SPOTIFY_LIBRARY_OWNER_USER_IDS
```

The owner-id binding is secret-managed so a public configuration file does not
publish an account identifier. Owner emails, when used, should be managed the
same way.

For an existing bearer-token deployment, roll over without a trust gap:

1. Install the private-host build with both new secrets, the old
   `SPOTIFY_PROXY_TOKEN`, and `SPOTIFY_ALLOW_LEGACY_PROXY_TOKEN=1`.
2. Install the updated Caddy route. It stops injecting the bearer, strips
   caller-supplied proxy headers on direct media traffic, and temporarily routes
   both signed envelopes and explicit legacy headers to the Bun verifier.
3. Add both Worker secrets and deploy the signed-request Worker.
4. Set `SPOTIFY_ALLOW_LEGACY_PROXY_TOKEN=0`, remove the old token, and restart
   the private service. Legacy mode is opt-in and exists only for this rollover.

Use `bun run upload` for a Wrangler dry run. Use `bun run cf-typegen` whenever
bindings change and review the generated type diff.

## API surface

Representative authenticated routes include:

- `GET /api/home`, `/api/search-index`, `/api/library`, and `/api/liked`
- `GET /api/playlist/:id` and `POST /api/playlist/:id/reorder`
- `GET`, `POST`, and `PATCH /api/songs/*`
- `POST /api/songs/spotify` and related bounded import routes
- `GET /api/files/*` and `/api/artwork/*`
- `GET`, `POST`, and `DELETE /api/likes`
- `GET /api/auth/session`, `GET /api/auth/me`
- `POST /api/auth/signin` and `POST /api/auth/signout`

Consult the route definitions and tests for the authoritative contract.

## Licensing and third parties

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The presence of a provider
adapter does not grant rights to download, redistribute, or retain provider
media.
