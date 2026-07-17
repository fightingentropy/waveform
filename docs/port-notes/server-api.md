# Server API Contract — RN Port Reference

Reconstruction-grade map of the HTTP API the React Native client must call.

Two server processes implement the SAME public surface (`/api/*`) with different
backends:

| File | Runtime | Backend | Role |
|---|---|---|---|
| `src/worker/index.ts` | Cloudflare Worker (Hono) | D1 (SQLite) + R2 (MEDIA) + IMAGES + ASSETS | The PUBLIC origin the RN app talks to (`https://music.streamarena.xyz` / `…workers.dev`). Owns auth (cookie sessions), the per-user D1 song library, likes, playlists, offline-downloads, play-events, podcasts, Spotify import, and Discover orchestration. |
| `src/server/local-music-server.ts` | Bun (`Bun.serve`) on the Mac mini | local filesystem (`~/Music`) | The MUSIC ORIGIN. Serves the owner's on-disk FLAC library + per-user folders, local artwork, local likes, Discover staging. NOT called directly by the RN app — the Worker REVERSE-PROXIES a subset of routes here. |

CRITICAL ARCHITECTURE FACT: the RN app should treat the **Worker** as its only
base URL. The Worker decides, per request, whether to answer from D1 itself or
transparently proxy to the Mac mini. Media URLs returned by the library can,
however, point at either origin (see signed-URL scheme), and the native iOS
AVPlayer fetches media URLs **directly** (bypassing the Worker), which is why the
signed-URL scheme exists.

---

## 0. Conventions shared by both servers

### 0.1 Error JSON shape
Every error is `{ "error": "<message>" }`. Some add fields:

- Duplicate song (upload): HTTP **409** with
  `{ "error": "Song already exists in your library", "code": "DUPLICATE_SONG", "existingSong": { "id", "title", "artist" } }`
  Emitted by Worker `POST /api/songs` (JSON + multipart paths) and by the local
  server's `handleRemoteSongUpload` / `handleSongUpload`. The client must detect
  `code === "DUPLICATE_SONG"` and offer "replace" (`replaceExisting: true`).
- Payload too large: HTTP **413** `{ "error": "<label> is too large" }`. Labels:
  `"Image file"`, `"Audio file"`, `"Lyrics text"`, `"Playback state"`,
  `"Song payload"`, `"Too many items (max 1000)"`, etc.
- Unsupported media type: HTTP **415** `{ "error": "Unsupported image format" | "Unsupported audio format" | "<label> type is not supported" }`.
- Rate limited: HTTP **429** `{ "error": "Too many requests" }` WITH a
  `Retry-After: <seconds>` header (Worker auth/register/verify routes only).
- Auth: HTTP **401** `{ "error": "Unauthorized" }`.
- Forbidden: HTTP **403** `{ "error": "Forbidden" }` (D1 ownership) or
  `{ "error": "This account does not have access to the local music library" }`
  (local server `forbiddenLibraryResponse`).
- Not found: HTTP **404** `{ "error": "Not found" | "Song not found" | "Playlist not found" | … }`.
- Not implemented / not configured: **501** (e.g. `/api/songs/spotify*` on the
  local server, unconfigured download provider), **503** (Discover not available).
- Upstream failures: **502** / **504** (`"Remote request timed out"`).

The Worker's global `onError` collapses unexpected throws to **500**
`{ "error": "Internal server error" }`; `ApiError` instances keep their status.

### 0.2 ETag / caching (`jsonCached`)
Both servers expose a `jsonCached(...)` helper used by GET endpoints:

- Sets `content-type: application/json; charset=utf-8`.
- Computes a **weak ETag**: Worker uses SHA-256 (first 32 hex chars), local
  server uses SHA-1 (first 32 hex chars). Format `W/"<hex>"`.
- Honors `If-None-Match` (comma-split, `*` or exact match) → **304** with no body.
- Default `Cache-Control: private, max-age=30, stale-while-revalidate=300`
  (overridable per route via `cacheControl`).

RN HAZARD: RN `fetch` does NOT transparently cache or send `If-None-Match`. The
client must persist ETags itself if it wants 304s; otherwise it always gets 200 +
full body (functionally fine). Do not rely on the platform HTTP cache.

Routes that are **NOT cached** (always fresh / `no-store` / plain `json()`):
- Worker: `/api/playback-state` (GET+PUT explicitly `cache-control: no-store`),
  `/api/play-events` (POST), `/api/offline-downloads` (all methods — plain
  `c.json`), `/api/likes` POST/DELETE, `/api/auth/*` (signin/signout/verify/
  resend/session), `/api/register`, `/api/profile/image` POST, `/api/songs` POST,
  `/api/songs/:id` PATCH, `/api/songs/:id/assets`, `/api/songs/spotify*`,
  `/api/discover/stage|promote`, `/api/playlist/:id/reorder`, `/api/files/*`
  (immutable cache, not jsonCached), `/api/artwork/r2/*` (immutable cache),
  `/api/podcast-*`.
- Local server: all mutations + media (`json()` sets `cache-control: no-store`;
  `serveFile` sets its own `public, max-age=…`).

GET endpoints that ARE jsonCached: see each route below ("Cache:" line).

### 0.3 Auth mechanisms
1. **Cookie session (Worker, real users).** Cookie `spotify_session` =
   random 32-byte hex token. Server stores `sha256Hex(token)` in `Session`.
   `httpOnly`, `secure` (when https or non-loopback host), `sameSite: Lax`,
   `path:/`, `maxAge = 30 days`. `getCurrentUser` joins `Session`→`User` where
   `expires > now`.
   RN HAZARD: cookies are NOT automatically managed by RN `fetch`. The client
   must capture `Set-Cookie` from signin and send `Cookie: spotify_session=…`
   on every authed request (or use a cookie-jar / native HTTP that does).
2. **Local-preview pseudo-user (Worker).** When the request host is loopback/
   `.local` AND a Mac-mini proxy is configured, the Worker injects
   `LOCAL_MAC_MINI_AUTH_USER` (`id: "local-mac-mini"`, `email:
   "erlin@spotify.local"`, `name: "Erlin"`, `image: "/profile.jpg"`). Irrelevant
   to production RN.
3. **Proxy token + user headers (Worker→Mac-mini, internal).** Worker sends
   `x-spotify-proxy-token`, `x-spotify-user-id`, `x-spotify-user-email`,
   `x-spotify-user-name`. The RN app never sends these.
4. **Local-network implicit user (local server).** A LAN/Tailscale/loopback peer
   is auto-trusted as the local owner. Not used by production RN.
5. **Signed media URLs (local server).** See §7. Used for direct media fetches
   (native AVPlayer) that cannot present a cookie or proxy token.

---

## 1. WORKER — middleware & routing order

`src/worker/index.ts` registers (in order):

1. `app.use("*")` — after handler, attaches security headers + credentialed CORS
   (`withSecurityHeaders`). Security headers: `X-Content-Type-Options: nosniff`,
   `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
   `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
   `Content-Security-Policy: frame-ancestors 'none'; object-src 'none'; base-uri 'self'`.
2. `app.use("/api/*")` — **Mac-mini proxy gate.** If
   `shouldProxyMusicRequest(c)` (see list below) and the proxy is configured,
   forwards verbatim to the Mac mini and returns its response (mutations require
   an authed user). Otherwise `next()`.
3. `app.use("/api/*")` — ensures D1 schema, builds the SQL tag, sets
   `c.var.user = getCurrentUser(...) ?? getLocalMacMiniAuthUser(c)` and `c.var.db`.

**Proxied-to-Mac-mini pathnames** (`shouldProxyMusicPathnameToMacMini`):
- `/api/files/local/*` → true
- `/api/artwork/local/*` → true
- `/api/songs/*` → true (EXCEPT `/api/songs/spotify*` → false)
- `/api/music/source`, `/api/home`, `/api/search-index`, `/api/library`,
  `/api/liked`, `/api/likes` → true
- `/api/songs`: GET → true; POST → true ONLY when content-type is NOT
  `application/json` (i.e. multipart upload proxies; JSON Spotify imports are
  handled in-Worker and may sub-proxy the finished file).

So for the same path the RN app may hit either the D1-backed handler or the
filesystem-backed handler depending on deployment config — but the RESPONSE
SHAPE is designed to match. Where they differ is noted per route.

Fallback: `app.all("*")` serves the SPA from `ASSETS` (static bundle) with
security headers. `app.onError` → ApiError status or 500.

Cron: `scheduled()` runs `runDiscoverFill(env)` (Top-50 staging fill). Not an
HTTP route.

---

## 2. AUTH / PROFILE (Worker)

### `GET /api/auth/session`
Returns current user or null. **Cache:** none (plain `c.json`).
Response: `{ "user": null }` OR
`{ "user": { "id", "email", "name": string|null, "image": string|null, "emailVerified": boolean } }`
(`publicUserForResponse` — may lazily store + return a default avatar URL).
Local-server equivalent `GET /api/auth/session` and `GET /api/auth/me` return
`{ "user": localUser()|null }`.

### `POST /api/auth/signin`
Body: `{ "email": string, "password": string }`.
Rate-limited: `auth`, **20 / 5 min** per IP → 429 + `Retry-After`.
- 400 `Email and password are required` if missing.
- 401 `Invalid email or password` (constant-time bcrypt compare against a dummy
  hash when the user/hash is absent — no user enumeration).
- Success: sets `spotify_session` cookie, returns
  `{ "user": <publicUser> }`.

### `POST /api/auth/signout`
No body. Deletes the `Session` row for the cookie token, clears cookie.
Returns **204** no body.

### `GET /api/auth/verify/:token?`  (also accepts `?token=`)
Email verification link target. Always **302 redirects** to
`<origin>/?verified=success|expired|invalid`. Single-use (token deleted on hit).
RN: only relevant if the app deep-links verification; otherwise ignore.

### `POST /api/auth/resend-verification`
Requires authed user (401 otherwise). Rate-limited `verify-resend` **5 / 10 min**.
Returns `{ "ok": true }` (generic regardless of send outcome).

### `POST /api/register`
Body: `{ "name"?: string, "email": string, "password": string }`.
Rate-limited `register` **5 / 10 min** → 429 + `Retry-After`.
- 400 `Email and password are required`; 400 `Password must be 8-128 characters`;
  400 `Display name is not available` (reserved owner names).
- Always returns **201** `{ "ok": true }` (same shape for new + duplicate email,
  anti-enumeration). Sends verification email best-effort for genuinely new
  accounts.

### `POST /api/profile/image`
Requires authed user. Two body modes:
1. `application/json`: `{ "image": "<base64>", "filename"?: string, "contentType"?: string }`
   (native app path — multipart is unreliable over the Capacitor HTTP bridge).
2. `multipart/form-data` with field `image` (a File).
Limits: `MAX_IMAGE_BYTES = 5 MiB` → 413; non-image → 415 (extension/MIME).
Stored at R2 key `users/<userId>/profile/<uuid><ext>`. Stored content-type is
derived from the sanitized extension (never the client's contentType — stored-XSS
guard). Response: `{ "user": <publicUser with new image url> }`.
Local-server equivalent stores to `cache/profile/local-user-profile.<ext>` and
serves it at `GET /api/profile/image/<file>`.

---

## 3. HOME / STATS / SEARCH-INDEX / LIBRARY (Worker)

### `GET /api/home`
**Cache:** default (`private, max-age=30, swr=300`), ETag.
Worker (D1) response: `{ "songs": PlayerSong[], "likedSongIds": string[] }`
(`songs` = all of the user's D1 songs via `songToPlayerSong`, ordered by title;
`likedSongIds` includes a legacy "everything liked" backfill on first read).
Mac-mini-proxied response (filesystem): `{ "songs": PlayerSong[], "likedSongIds": string[] }`
where `songs` are local files (media URLs SIGNED — see §7); empty arrays when the
account can't access the local library.

### `GET /api/stats/home`
Requires authed user (401). The local pseudo-user returns empty.
**Cache:** default + ETag.
Response: `{ "recentlyPlayed": PlayerSong[], "mostPlayed": { "song": PlayerSong, "playCount": number }[] }`.
`recentlyPlayed` = up to 20 distinct songs by most-recent PlayEvent; `mostPlayed`
= up to 20 by play count desc. Songs are reconstructed from the JSON snapshot
stored on each play-event (NOT a Song FK). Before responding, the Worker sends
the combined media fields (maximum 40 songs) to the Mac mini's internal
`POST /api/media/refresh` endpoint so local artwork/audio/lyrics URLs receive
fresh 24-hour signatures. Pruned `.discover` paths are resolved to a matching
current library copy by id or exact normalized title/artist. If the mini is
unavailable, history still returns with its stored URLs and the client falls
back normally.

### `GET /api/search-index`
**Cache:** `private, max-age=300, swr=600` + ETag.
Worker (D1): `{ "songs": PlayerSong[] }` (lighter projection: id/title/artist/
imageUrl/audioUrl/createdAt, ordered by createdAt desc, limit 5000).
Mac-mini-proxied: `{ "songs": [{ "id","title","artist","imageUrl","audioUrl","createdAt","source","localPath" }] }`
(media URLs signed).

### `GET /api/library`
**Cache:** `private, max-age=300, swr=600` + ETag.
Worker (D1): `{ "playlists": Playlist[], "userId": string|null }` where each
playlist is `{ "id","name","imageUrl","userId","createdAt","songsCount": number }`.
Mac-mini-proxied: `{ "playlists": [], "userId": <id|null> }` (the filesystem
server has no playlists).

### `GET /api/music/source`  (local server / proxied only)
**Cache:** `private, max-age=15, swr=120` + ETag.
Response: `{ "root": string|null, "songsCount": number, "scannedAt": ISOString|null }`.
`?refresh=1` forces a rescan. No Worker-native handler; only meaningful when the
Mac-mini proxy is configured.

---

## 4. SONGS CRUD + SPOTIFY IMPORT (Worker)

`PlayerSong` shape (the canonical media object, from `songToPlayerSong` /
`coercePlayerSongPayload`):
```
{
  id: string, title: string, artist: string,
  album?: string, imageUrl: string, audioUrl: string,
  lyricsUrl?: string, description?: string, link?: string,
  duration?: number (seconds), audioBitDepth?: number, audioSampleRate?: number,
  createdAt: string (ISO), source?: "server"|"browser-local"|"picked-file"|"radio"|…,
  localPath?: string,
  staged?: boolean, discoverTrackId?: string   // only on Discover-staged songs
}
```

### `GET /api/songs`
**Cache:** default + ETag.
Worker (D1): `SongRow[]` (raw rows: id/title/artist/album/duration/imageUrl/
audioUrl/lyricsUrl/audioBitDepth/audioSampleRate/userId/createdAt, ordered by
title, limit 5000). Empty array when unauthed.
Mac-mini-proxied: `PlayerSong[]` (signed media URLs). NOTE the slight shape
difference (raw rows vs PlayerSong) between the two backends.

### `GET /api/songs/:id`
Requires authed user (401). 404 if not owned.
**Cache:** default + ETag. Response: a single `PlayerSong`.
Local-server: returns the scanned `PlayerSong` (signed) or 404.

### `POST /api/songs`
Requires authed user. Two content-types:

**A. `application/json`** (Spotify import OR remote-URL import):
Body (`SongPayload`): `{ mode?, title, artist, album?, duration?|durationMs?,
imageUrl?, audioUrl?, spotifyUrl?, service?, quality?, qualityProfile?,
outputFormat?, region?, lyricsText?, replaceExisting? }`.
- `assertServerImportOutputFormat`: server imports must be `flac` (default) →
  else 400 ("… only available for browser/local saves").
- 400 if `title`/`artist` missing.
- Duplicate (same lower(title)+lower(artist)) & `!replaceExisting` → **409
  DUPLICATE_SONG**.
- If `mode==="spotify"` or `spotifyUrl` present: resolves a streamable source via
  the multi-provider stack (`resolveStreamUrl`), downloads the audio, stores to
  R2 (or proxies the finished file to the Mac mini when configured), uploads a
  cover, stores lyrics.
- Else (`audioUrl`): must be valid http(s); fetched, MIME-validated against
  `AUDIO_MIME_TYPES` (else 415), size-checked (`MAX_AUDIO_BYTES = 100 MiB` → 413),
  stored to R2.
- Success: **201** (new) or **200** (replace) with the created/updated `SongRow`
  (via the RETURNING clause). New songs are auto-liked.

**B. `multipart/form-data`** (direct file upload):
Fields: `title`, `artist`, `image` (File), `audio` (File). All required → else
400. `image > 5 MiB` → 413; `audio > 100 MiB` → 413. Stored to R2 under
`music/<artist>/<title>/cover|audio/<uuid><ext>`. Returns SongRow (201/200).
When proxied to Mac-mini, the multipart body is forwarded verbatim and the
filesystem server writes files + a `.spotify.json` sidecar (returns the scanned
`PlayerSong`).

### `PATCH /api/songs/:id`
Requires authed user; 404 if missing, 403 if not owner.
Body: `{ "title": string, "artist": string }` (both required → 400).
Returns the updated `PlayerSong`.
Local-server equivalent rewrites the sidecar + rescans.

### `POST /api/songs/:id/assets`
Requires authed user; 404/403 as above. `multipart/form-data` with optional
`image` (File ≤5 MiB), `lyricsFile` (File ≤2 MiB), `lyricsText` (string ≤2 MiB).
At least one must change → else 400. Returns updated `PlayerSong`.

### Spotify endpoints (Worker-only; local server returns **501**)

#### `POST /api/songs/spotify`
Requires authed user. Body (`ActionPayload`): `{ action: "fetch"|"availability"|"lyrics",
spotifyUrl, region?, title?, artist?, album? }`.
- `action: "lyrics"` → `{ "lyrics": string, "fileName": string }` (404 if none).
- `action: "availability"` →
  `{ "availability": { "tidal": boolean, "qobuz": boolean, "tidalUrl": string, "qobuzUrl": string } }`.
- `action: "fetch"` →
  `{ "track": { spotifyId, title, artist, album, releaseDate, totalPlays, durationMs, imageUrl, previewUrl }, "availability": {…as above…} }`.
- Other/missing action → 400.

#### `POST /api/songs/spotify/file`
Requires authed user. Body = `SongPayload` (needs `spotifyUrl` + optionally
`service`/`quality`/`qualityProfile`/`region`). Resolves + streams the audio back
**as a file download**: `Content-Type` = upstream audio type,
`Content-Disposition: attachment; filename="<artist> - <title><ext>"`. Not JSON.

#### `POST /api/songs/spotify/batch`
Requires authed user. Body (`BatchDownloadPayload`): `{ spotifyUrl, region?,
qualityProfile?, service?, outputFormat?, includeMetadata?, includeLyrics?,
includeCover?, spotifyCookie? }`. Resolves a track/album/playlist/Liked-Songs URL
into a track list (no download). Response:
```
{ "batchInfo": { "type": "track"|"album"|"playlist", "title", "artist",
    "trackCount": number, "format": "flac"|…, "trackIds": string[],
    "tracks": [{ spotifyId, title, artist, album, releaseDate, totalPlays,
      durationMs, imageUrl, previewUrl }] },
  "message": "Found N tracks. Click Download All to start." }
```
- 400 invalid URL / >10,000 tracks / Liked-Songs without `spotifyCookie`.
- 404 `No tracks found`.
- `SpotifyPathfinderError` → its status; other failures → 500 `Failed to process batch`.

---

## 5. LIKES (Worker + local)

Two related Worker endpoints (D1):

### `GET /api/likes`
**Cache:** default + ETag. `{ "likes": string[], "likedSongIds": string[] }`
(both arrays identical; legacy `likes` alias retained). Empty when unauthed.

### `POST /api/likes`
Requires authed user. Body `{ "songId": string }`. 400 missing, 404 not owned.
`{ "ok": true }`. Idempotent insert (`ON CONFLICT DO NOTHING`).

### `DELETE /api/likes`
Requires authed user. Body `{ "songId": string }`. 400/404 as above. `{ "ok": true }`.

### `GET /api/liked`
Requires authed user (401). **Cache:** default + ETag.
`{ "songs": PlayerSong[], "likedSongIds": string[] }` (full liked-song objects,
most-recent first).
Mac-mini-proxied variant returns local liked songs (signed media URLs).

### Local-server `/api/likes` (filesystem `handleLikes`)
- GET: jsonCached `{ "likes": string[], "likedSongIds": string[] }`.
- POST/DELETE: body `{ "songId": string }`; 401 if no user, 400 missing,
  404 if song not in the visible library. Returns
  `{ "ok": true, "likes": string[], "likedSongIds": string[] }`. POST=like,
  DELETE=unlike (serialized read-modify-write, persisted to
  `local-music-likes.json`).

---

## 6. PLAYLIST + REORDER (Worker, D1-only)

### `GET /api/playlist/:id`
Requires authed user (401); 404 if missing, 403 if not owner.
**Cache:** default + ETag.
`{ "playlist": { id, name, imageUrl, userId, createdAt },
   "songs": PlayerSong[] (ordered by PlaylistSong.order asc),
   "likedSongIds": string[] }`.

### `POST /api/playlist/:id/reorder`
Requires authed user; 404/403 as above.
Body `{ "songIds": string[] }` (else 400). Server intersects the requested order
with the playlist's existing songs, appends any omitted songs in their old order,
and writes `PlaylistSong.order`. Returns `{ "ok": true, "songIds": string[] }`
(the FINAL canonical order).

NOTE: there is **no create/delete-playlist or add/remove-song HTTP route** in
either file. Playlist creation/membership must be done elsewhere (DB seeding /
out of scope here). The RN port only needs GET + reorder.

---

## 7. MEDIA ROUTES + SIGNED-URL SCHEME

This is the load-bearing section for playback.

### 7.1 Worker R2-backed media

#### `GET /api/files/*`
Serves R2 objects by key (`/api/files/<key…>`).
- **Profile-image keys** (`users/<id>/profile/<file>`, regex
  `^users/[^/]+/profile/[^/]+$`) are served **WITHOUT auth** (plain `<img>` loads
  carry no cookie). Content-type pinned to a safe image type; anything else forced
  to `Content-Disposition: attachment`.
- All other keys require an authed user AND `storageKeyBelongsToUser` (the key
  must be the user's `image`, or a Song's `audioUrl`/`imageUrl`/`lyricsUrl`) → else
  **404**.
- **Range supported.** `Range: bytes=…` → 206 with `Content-Range`,
  `Content-Length`, `Accept-Ranges: bytes`; malformed/unsatisfiable → **416**
  with `Content-Range: bytes */<size>`. Full → 200.
- `Cache-Control: private, max-age=31536000, immutable`. Security headers applied.

#### `GET /api/artwork/r2/*?w=<width>`
Requires authed user + `storageKeyBelongsToUser` → else 404. `w` clamped to
[32,1024], default 256 (`parseArtworkWidth`). Transforms the R2 image to WebP
(`fit: cover`, quality 82) via the IMAGES binding, edge-caches in
`caches.open("spotify-artwork-v1")`. Returns the transformed image (falls back to
the raw object on transform failure). `Cache-Control: private, max-age=31536000,
immutable`. **No Range.** 415 if the key's inferred type isn't an image.

#### `GET /api/artwork/*`  (catch-all)
**302 redirect** to `/apple-icon.png` (placeholder art).

### 7.2 Local-server filesystem media (proxied via Worker, or fetched DIRECTLY)

These live on the Mac mini and are how on-disk FLACs are streamed. Media URLs in
library responses point here as `/api/files/local/<encoded-rel-path>` and
`/api/artwork/local/<encoded-id>`.

#### `GET /api/files/local/<relpath>`
Streams a file from the resolved library root. Authorization, in order:
1. The request's own identity (cookie-proxy headers OR implicit local user) maps
   to a library source; OR
2. A **valid signed URL** (`hasValidMediaSignature`) — this is the path the native
   iOS AVPlayer uses, since it fetches the URL directly with no cookie.
- **Range supported** (`serveFile` / `parseRangeHeader`): 206 + `Content-Range`/
  `Content-Length`/`Accept-Ranges: bytes`; unsatisfiable → 416; `If-None-Match`
  weak-ETag → 304. ETag = `W/"<sizeHex>-<mtimeHex>"`. `Cache-Control:
  public, max-age=3600`.
- Symlink-escape guarded (`resolveInsideReal`).

#### `GET /api/artwork/local/<id>`
Returns embedded cover art (or an iTunes-looked-up cover, cached under
`artwork/`), or **302 → `/apple-icon.png`** when none. A cover sidecar wins over
the extraction cache. Range supported via `serveFile` (`public, max-age=86400`).
Same signed-URL/identity authorization as `/api/files/local/`.

### 7.3 THE SIGNED-URL SCHEME (exact)

Constants (`local-music-server.ts`):
- `MEDIA_USER_SEARCH_PARAM  = "spotify_user"`
- `MEDIA_SCOPE_SEARCH_PARAM = "spotify_scope"`
- `MEDIA_SIGNATURE_SEARCH_PARAM = "spotify_sig"`

**When a URL is signed:** `appendMediaSignature(mediaUrl, identity)` signs ONLY
when `proxyToken` is set, the identity exists, and the identity is **not local**
(`identity.local === false`), AND the path starts with `/api/files/local/` or
`/api/artwork/local/`. The implicit local-owner identity is NOT signed (it is
trusted by network position); proxied remote users ARE signed.

**Query params appended:**
- `spotify_user`  = `identity.id`
- `spotify_scope` = `"shared"` if the identity is the local library owner
  (`mediaScopeForIdentity` → `isLocalLibraryOwner`), else `"user"`.
- `spotify_sig`   = HMAC signature (below).

**HMAC formula** (`mediaSignature(userId, scope, pathname)`):
```
HMAC_SHA256( key = proxyToken,
             message = userId + "\0" + scope + "\0" + pathname )
  → hex, first 40 chars
```
- `pathname` is the URL pathname ONLY (no query string), e.g.
  `/api/files/local/Artist/Song.flac` (already percent-encoded per segment).
- `proxyToken` = env `SPOTIFY_PROXY_TOKEN` (shared secret between Worker and Mac
  mini). If unset, signing is disabled and `hasValidMediaSignature` always false.

**Verification** (`hasValidMediaSignature`): reads the three params, requires
`scope ∈ {"shared","user"}`, recomputes the HMAC over the request pathname, and
`timingSafeEqual`-compares. On success, `librarySourceForMediaRequest` picks the
**shared** source for `scope==="shared"` else the per-user source
(`userLibrarySource(userId)` — directory derived from `sha256(userId)[:32]`).

**Scope values:**
- `"shared"` — the owner's main `~/Music` library (one shared cache).
- `"user"`   — a registered non-owner user's private folder
  (`cache/user-music/<sha256(userId)[:32]>/music`).

**Discover staging URLs** are signed for the SHARED scope under the local-owner
identity (`DISCOVER_MEDIA_IDENTITY`, `local: false`) so the native player can
stream `.discover/*` files directly. See §8.

PORTING NOTES for media:
- The RN audio player must use whatever `audioUrl`/`imageUrl`/`lyricsUrl` the
  library responses give it **verbatim, including the `spotify_user/_scope/_sig`
  query string** — do not strip or re-encode them or the signature breaks.
- Media URLs are returned as **path-relative** strings (`/api/files/local/…`).
  The RN client must prefix them with the Worker base origin. (Web code used
  relative fetch; RN MUST build absolute URLs — see Hazards.)
- For locked-screen playback the native player fetches media directly (signed
  URL), so it MUST be able to reach the same origin the URL implies.

---

## 8. DISCOVER (trending / stage / promote / staging-sync)

Top-50 instant-play system. Spotify's "Top 50 - Global" playlist
(`37i9dQZEVXbMDoHDwVN2tF`) is pre-downloaded into a hidden `.discover` folder on
the Mac mini; tapping a track plays it instantly without library insertion.

### Worker endpoints

#### `GET /api/discover/trending`
**Cache:** `public, max-age=120` (empty) /
`public, max-age=1800, swr=7200` (no Mac mini) /
`private, max-age=30, swr=300` (Mac mini configured — staged status is volatile).
Response: `{ "tracks": DiscoverTrendingTrack[] }`. Each track:
`{ id, title, artist, album, imageUrl, durationMs: number|null, spotifyUrl }`
plus, when the Mac mini is configured:
`staged: boolean` and (if staged) `audioId: string, audioUrl: string` (a SIGNED
`/api/files/local/.discover/…` URL ready to play instantly).

#### `POST /api/discover/stage`
Requires authed user; 503 if Mac mini not configured.
Body: `SongPayload & { trackId? }` (needs `spotifyUrl` or `trackId`, plus `title`
+ `artist`). Resolves a streamable source then asks the Mac mini to materialize
ONE track into `.discover` (blocking, up to 120 s). Returns the playable
(signed) `PlayerSong` (with `staged: true`, `discoverTrackId`), or a 502/error
JSON from the Mac mini passed through.

#### `POST /api/discover/promote`
Requires authed user; 503 if not configured. Body `{ "trackId": string, "finalId"?: string }`.
Moves the staged file out of `.discover` into the visible library so it can be
liked/playlisted/downloaded. Returns the now-real (signed) `PlayerSong`.
Idempotent: if already promoted and `finalId` resolves, returns that song.

### Local-server (Mac mini) Discover endpoints (called only by the Worker)

- `GET /api/discover/staging` → `{ "entries": [{ trackId, id, audioUrl (signed), duration? }] }`.
  jsonCached `private, max-age=10`. Empty unless the request maps to the shared source.
- `POST /api/discover/sync` → body `{ "present": string[], "stage": DiscoverStageItem[] }`.
  Prunes entries no longer in `present` (after TTL = 14 days), background-stages
  the `stage` items (serially), returns the current staging status body. 401 if
  no user, 403 if not the shared owner.
- `POST /api/discover/stage` → body `DiscoverStageItem` (`{ trackId, title,
  artist, album?, imageUrl?, durationMs?, resolved }`). Materializes one track now
  and returns the signed `PlayerSong` (400 missing fields, 502 on failure).
- `POST /api/discover/promote` → body `{ trackId, finalId? }`. Same semantics as
  the Worker route; returns the signed promoted song.

`DiscoverStageItem.resolved` is the Worker's `ResolvedAudioDownload` descriptor
(best candidate + `fallbacks[]`, each with `service`, `streamUrl`,
`headers?`, `contentType?`, `licensedStream?`, `userAgent?`). The RN app NEVER
constructs this — only the Worker does, during stage. RN only consumes the
trending list and (optionally) calls stage/promote with track metadata.

---

## 9. PLAYBACK-STATE (Worker, D1)

Cross-device "resume where you left off" snapshot.

`PlaybackStateSnapshot` shape (`coercePlaybackStatePayload`):
```
{ version: <PLAYBACK_STATE_VERSION>, accountScope: string ("anonymous" default),
  queue: PlayerSong[], currentIndex: number, song: PlayerSong,
  currentTime: number (sec), isPlaying: boolean,
  updatedAt: number (ms epoch), deviceId: string ("unknown" default) }
```
Non-persistable songs are filtered out of the queue: `source` ∈
{`browser-local`,`picked-file`,`radio`}, ids starting with those prefixes, or
`audioUrl` starting with `blob:` are dropped (these are device-local and can't
resume on another device).

### `GET /api/playback-state`
Requires authed user (or local pseudo-user). **`cache-control: no-store`.**
`{ "state": PlaybackStateSnapshot | null }`.

### `PUT /api/playback-state`
Requires authed user. Body `{ "state": <snapshot> }`.
- 400 `Invalid playback state` if it can't be coerced (needs at least one
  persistable song).
- 413 if serialized state > 512,000 bytes.
- **Last-write-wins by `updatedAt`:** if the stored snapshot's `updatedAt` is
  NEWER than the incoming one, the server keeps the stored one and returns IT
  (the client should reconcile to the returned state).
- Returns `{ "state": <effective snapshot> }`, `no-store`.

---

## 10. PLAY-EVENTS (Worker, D1)

### `POST /api/play-events`
Requires authed user. Local pseudo-user → no-op **201** `{ "ok": true }` (no User
FK row). Body `{ "song": PlayerSong, "durationMs"?: number }`.
- 400 `Invalid song` (can't coerce).
- 400 `Song references a device-local URL` if any of audio/image/lyrics URL is a
  `blob:`/`capacitor:`/`file:` / `_capacitor_file_` / offline-playback URL
  (`playEventSongHasDeviceLocalUrl`) — these can't be replayed cross-device.
- 413 if the song JSON snapshot > 512,000 bytes.
- Stores a JSON snapshot (no Song FK; ids may live only on the Mac mini). Prunes
  events older than 180 days for the user. Returns **201** `{ "ok": true }`.
Feeds `GET /api/stats/home`.

---

## 11. OFFLINE-DOWNLOADS (Worker, D1)

The server-side REGISTRY of which songs the device has cached offline + WHY
(scopes). Limits: `MAX_OFFLINE_DOWNLOAD_ITEMS = 1000`,
`MAX_OFFLINE_SONG_JSON_BYTES = 64 KiB`. Each item de-duped by `song.id`; scopes
de-duped, max 32 per song, each ≤256 chars; default scope `song:<id>`.

### `GET /api/offline-downloads?limit=&offset=`
Requires authed user. **Not cached** (plain `c.json`). `limit` clamped [1,100]
(default 100), `offset` ≥0.
`{ "downloads": [{ "song": PlayerSong, "pinnedBy": string[] (scopes), "updatedAt": string }],
   "nextOffset": number|null }`.

### `PUT /api/offline-downloads`  (replace-all, atomic)
Body `{ "items": [{ "song": PlayerSong, "scopes"?: string[] }] }`.
- 400 `items must be an array`; 413 `Too many items (max 1000)`;
  400 `items[N].song is invalid`; 413 `items[N].song is too large`.
- Runs as a single D1 `batch()` transaction: DELETE-all-then-INSERT. De-duped so
  the unique `(userId, songId)` constraint can't abort mid-write.
- `{ "ok": true, "count": number }`.

### `POST /api/offline-downloads`  (upsert / merge scopes)
Same body shape. For each item, merges scopes into any existing row (or inserts).
`{ "ok": true, "count": number }`.

### `DELETE /api/offline-downloads`
Body `{ "clearAll"?: boolean, "songId"?: string, "scope"?: string }`.
- `clearAll: true` → wipes all rows → `{ "ok": true }`.
- 400 `Provide songId, scope, or clearAll` if none given.
- Otherwise: removes the given `scope` from the matched song(s) (or all songs when
  only `scope` given); a row with no remaining scopes is deleted entirely.
- `{ "ok": true }`.

---

## 12. PODCASTS (Worker)

Static show list from `@/lib/podcasts` (`PODCAST_SHOWS`). The RN app references
shows by `id`.

### `GET /api/podcast-feeds/:id`
404 `Podcast not found` if unknown id. Returns the raw RSS XML
(`content-type: application/rss+xml; charset=utf-8`,
`Cache-Control: public, max-age=300, swr=1800`). Per-isolate 5-min feed cache.

### `GET /api/podcast-media/:id?url=<mediaUrl>`
Relays a podcast media file. 404 unknown id; 400 invalid url; **403
`Unknown podcast media URL`** if the url isn't whitelisted by the feed
(open-proxy guard — only URLs appearing in the show's feed/cover art are allowed).
- **Range supported** (passes the client `Range` upstream; relays `content-type`,
  `content-length`, `content-range`, `accept-ranges`, `etag`, `last-modified`).
- `Cache-Control: public, max-age=3600`. 502 if upstream not ok.

---

## 13. PORTING HAZARDS (server-contract-specific)

1. **Relative media URLs.** All `audioUrl`/`imageUrl`/`lyricsUrl` come back as
   path-relative (`/api/files/…`, `/api/files/local/…`, `/api/artwork/…`). Web
   code relied on the browser resolving these against the page origin. RN `fetch`
   and the native audio player MUST prepend the configured Worker base URL. A
   single `resolveMediaUrl(path)` helper is mandatory.

2. **Signed media query string is sacred.** `?spotify_user&spotify_scope&spotify_sig`
   must be preserved byte-for-byte. Re-encoding the path or stripping the query
   invalidates the HMAC → 403. Do not run signed URLs through a generic
   URL-normalizer.

3. **Cookie auth is manual in RN.** No automatic cookie jar with bare `fetch`.
   Capture `Set-Cookie` on signin, store the `spotify_session` token securely
   (Keychain/SecureStore), and attach `Cookie:` on every authed request. The
   web/Capacitor app got this for free; RN does not.

4. **ETag/304 won't happen for free.** RN's HTTP stack won't send `If-None-Match`
   automatically. Treat 304 handling as optional client-side optimization; the
   server is happy to always send 200 + body.

5. **Two backends, slightly different shapes for the same path.** `/api/songs`
   GET returns raw `SongRow[]` from D1 but `PlayerSong[]` when proxied to the Mac
   mini; `/api/home`/`/api/liked`/`/api/search-index` differ subtly too. The RN
   client should normalize through one `toPlayerSong()` adapter that tolerates
   both (raw row has `duration` as a number, no `source`/`localPath`; local has
   `source:"server"`, `localPath`, signed URLs).

6. **Device-local URLs are rejected by play-events & filtered from playback-state.**
   The RN app must NOT send `blob:`/`file:`/`capacitor:`/offline-playback URLs to
   `/api/play-events` (400) and should expect them stripped from any
   `/api/playback-state` it PUTs. Offline songs need real server URLs in those
   payloads.

7. **Range/seek depends on server support.** `/api/files/*`, `/api/files/local/*`,
   `/api/podcast-media/:id` support Range; `/api/artwork/r2/*` and
   `/api/artwork/local/*` (artwork) effectively don't matter for seeking. The RN
   player should use a Range-capable HTTP audio source for the audio routes.

8. **`/api/artwork/r2/*?w=` is the resize endpoint.** For list thumbnails prefer
   `?w=<displayWidthPx*scale>` (clamped 32–1024) to cut bytes; full art omits `w`.
   `/api/artwork/local/*` does not resize.

9. **Multipart vs base64-JSON for uploads.** `POST /api/profile/image` and the
   Spotify-import paths accept base64 JSON specifically because the Capacitor HTTP
   bridge can't do multipart reliably. In RN, prefer multipart `FormData` (RN
   supports it natively) for `POST /api/songs`/`/assets`/`/profile/image`, but the
   base64-JSON `profile/image` path remains available as a fallback.

10. **Discover `resolved` descriptor is Worker-internal.** RN must not try to
    build the provider stack; it only reads `/api/discover/trending` and may call
    `/api/discover/stage` / `/promote` with plain track metadata.
