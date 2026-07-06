# Port "Spotify" (self-hosted music app) from Capacitor+React to Expo / React Native

You are porting a polished, working, self-hosted Spotify clone to a **fresh Expo (React Native) app**. Read this entire brief before starting.

## 0. The situation

- The existing app is a **React web app** (Vite + React 19 + Tailwind v4 + Zustand) wrapped in **Capacitor** for iOS. It also runs as a PWA.
- The **backend does NOT change**. It is a Cloudflare Worker that proxies to a self-hosted Mac-mini Bun server. You are building a **new native client against the exact same HTTP API** (base origin `https://spotify.streamarena.xyz`).
- **The existing source is available in this repo** — study it for exact behavior, look, and the API contract:
  - `src/client/` (pages, auth, offline, api client), `src/components/` (PlayerBar, NowPlayingSheet, SongGrid, etc.), `src/store/` (player.ts, likes.ts), `src/lib/` (crossfade-curve, native-audio, player-song, song-utils), `src/types/player.ts`, `src/client/styles.css` (design system), `ios/App/App/AudioEnginePlugin.swift` (the native audio engine to mirror), `src/server/local-music-server.ts` + `src/worker/index.ts` (the API — read-only reference).
- **Reuse what's portable.** The Zustand stores, the types, the crossfade math, the shuffle/repeat logic, and all the pure-TS API/client logic port almost verbatim. Only the **UI (DOM→RN), the audio engine, the offline storage, and a few native bridges** are rewritten. (See §11 for the store/audio internals that do **not** port cleanly — `window`/`localStorage` probes throughout the stores, a relative `fetch("/api/likes")` + Capacitor haptics inside `likes.ts`, and the Web-Audio-bound fade bodies in `PlayerBar.tsx`.)

Goal: **pixel-faithful look, identical feature set, same backend.**

---

## 1. HARD-WON LESSONS — read these or you WILL waste days

1. **Media URLs are pre-signed; the player streams them directly without cookies.** The server authorizes `/api/files/local/*` (audio + lyrics) and `/api/artwork/local/*` (art) **either** by session cookie **or** by a signed query string. Songs returned by the API already carry signed `audioUrl` / `imageUrl` / `lyricsUrl` like:
   `/api/files/local/Artist%20-%20Title.flac?spotify_user=<id>&spotify_scope=shared&spotify_sig=<40hex>`
   The native audio player (react-native-track-player / AVPlayer) fetches these over the network and **cannot send the app's session cookie** — the **signature is what authorizes streaming**. So:
   - **Pass `audioUrl`/`imageUrl` to the player VERBATIM** (keep the query params). Only prepend the API origin (they're returned relative). Do not re-encode or strip them.
   - This is non-negotiable: an unsigned media URL returns **403** and the track silently fails to load (0:00, no audio). This was a real multi-hour bug.
   - Signature scheme (for reference; the server already does it): `HMAC_SHA256(proxyToken, userId + "\0" + scope + "\0" + pathname).hex().slice(0,40)`, `scope` = `"shared"` (the owner) or `"user"`. You do NOT implement this client-side; you just preserve the URLs.

2. **Two auth channels, on purpose.** API/data calls (auth, home, likes, playlists, offline, playback-state) authenticate with the **session cookie**. Media streaming authenticates with the **signed URL**. RN's `fetch` keeps cookies in the native cookie store by default (iOS `NSHTTPCookieStorage`, Android `CookieManager`), so `credentials: "include"`-style works for API calls. **Do not assume the audio player shares that cookie jar** — it doesn't; that's why media is signed.

3. **API origin + relative URLs.** Everything goes to `https://spotify.streamarena.xyz`. The web app had a `capacitor://` URL-rewriting shim (`src/lib/native-api.ts`, `src/client/native-network.ts`) — **delete that concept entirely**; in RN just use the absolute base origin. Media URLs come back relative → prepend the base before handing to the player/image.

4. **Crossfade is the single hardest feature.** The current app does a **dual-deck (A/B) equal-power crossfade**: the outgoing track plays to its end fading down on `cos(θ)` while the next rises on `sin(θ)` (so `cos²+sin² = 1`, constant loudness). On iOS it uses **two native AVPlayer decks** (`AudioEnginePlugin.swift`). `react-native-track-player` is **single-player** — it can't overlap two tracks. Pick a path (see §7). The fade math (`src/lib/crossfade-curve.ts`) and the **scheduling/target/commit skeleton** in `src/components/PlayerBar.tsx` port; the actual **fade bodies do not** — they're fused to Web Audio / `HTMLMediaElement.volume` and are a rewrite (see §7 + §11).

5. **Lock screen / background / remote controls** (play/pause/next/prev/seek from the lock screen + headphones, now-playing metadata + artwork) are **free with react-native-track-player** — it replaces the entire custom Swift plugin (`AudioEnginePlugin.swift` + `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`). The tension is only crossfade (#4).

6. **Offline files play directly in RN.** RN `fetch`/players read `file://` with HTTP Range support on both platforms, so the Capacitor-only `blob:` materialization workaround (`capacitor-offline.ts`) is **gone** — just store and play `file://` paths.

7. **`isNativeCapacitorApp()` / `Capacitor.*` / service worker / IndexedDB / Cache API / `manifest.webmanifest`** do not exist in RN. Replace per §3.

---

## 2. Architecture

```
Expo RN app  ──HTTPS──>  Cloudflare Worker (spotify.streamarena.xyz)  ──>  Mac-mini Bun server
  (new)                   (unchanged)                                          (unchanged: music files, signing, discover staging)
```

Layers you build: navigation/screens (RN), state (reuse Zustand stores), API client (reuse shapes, swap fetch base), audio engine (RNTP + optional custom crossfade), offline storage (expo-file-system + expo-sqlite), native bridges (haptics, secure store).

---

## 3. Recommended Expo stack

- **Expo SDK (latest), TypeScript, Expo Router** (file-based routing → maps cleanly to the tab + stack structure).
- **NativeWind** (Tailwind-class syntax in RN) so the existing Tailwind classes port with minimal translation. Mirror the theme tokens in §4.
- **Zustand** — reuse `src/store/player.ts` and `src/store/likes.ts` almost verbatim (strip DOM/`localStorage` → use `expo-secure-store`/`async-storage` for persistence; strip web-audio bits).
- **Audio: `react-native-track-player`** for queue + background + lock screen + remote commands. For crossfade, see §7.
- **`expo-file-system`** (download offline media → `file://`), **`expo-sqlite`** (offline records + cached snapshots; replaces IndexedDB), **`expo-haptics`** (replaces `@capacitor/haptics`; `impactLight`/`selectionAsync`), **`expo-image`** (fast cached cover art), **`expo-secure-store`** (session/user cache).
- **`lucide-react-native`** (drop-in for the existing `lucide-react` icons — same names).
- **`@gorhom/bottom-sheet`** (Now Playing sheet, Queue sheet, Sleep timer), **`react-native-gesture-handler`** + **`react-native-reanimated`** (swipe-to-change-track on the artwork, swipe-down-to-dismiss, the active:scale press feedback, marquee).
- **`@react-native-cookies/cookies`** if you need to inspect/manage the session cookie explicitly.
- **EAS Build** for iOS/Android (no more 7-day manual re-sign; note: you still need an Apple Developer account for TestFlight/long-lived provisioning).

---

## 4. Design system (dark theme — match exactly)

Tokens (from `src/client/styles.css`):
```ts
const colors = {
  background: '#0a0a0a',        // page bg (near-black)
  surface:    '#121212',        // mini-player / elevated bg
  foreground: '#ededed',        // primary text
  textMuted:  '#b3b3b3',        // secondary text (also rgba(255,255,255,.62))
  textDim:    'rgba(255,255,255,.46)', // captions
  green:      '#1ed760',        // Spotify green (play buttons, active)
  emerald:    'rgb(16,185,129)',// emerald-500 (likes, sliders, accents)
  emeraldDarkCheck: '#04140d',  // the dark check inside the filled "downloaded" badge
  cardSurface:'rgba(255,255,255,.08)',
  cardHover:  'rgba(255,255,255,.09)',
  cardActive: 'rgba(255,255,255,.12)',
  border:     'rgba(255,255,255,.10)',
  iconIdle:   'rgba(255,255,255,.70)',
  backdrop:   'rgba(0,0,0,.60)', // now-playing sheet backdrop
  // section accents: cyan-500/15 (radio), fuchsia-500/15 (podcasts)
};
```
- **Font**: system sans (SF Pro on iOS). Antialiased. Sizes: title 24–32 bold, song title 16 medium, artist 14, caption 13, tiny labels 10–12.
- **Layout**: bottom tab bar height **52px**, mini player **68px**, respect safe-area insets. Horizontal scroller cards **144px** (w-36) / **160px** (w-40 ≥sm), `p-3` (12) internal, `gap-4` (16) between, square cover with `rounded` (~6–8) + drop shadow `0 10px 28px rgba(0,0,0,.35)`. List rows min-height 64. Radii: card 6–8, list row 12, now-playing art 16, buttons full.
- **Signature components**: square cover card with a **floating circular green play button bottom-right** (opacity 0 → 100 on hover/active; on touch it's shown for the active tile); when the tile is the current song its title turns **green** and shows a **Pause** icon. **Two greens, by surface (don't use one everywhere):** the Home *scroller* tile uses Spotify-green **`#1ed760`** (play button + active title); the grid `SongCard` / `SongListItem` — and the Now Playing transport, sliders, and likes — use **`emerald-500` (`rgb(16,185,129)`)**. Mini player bar (cover + title/artist + heart + play, tap opens Now Playing). Now Playing sheet: big square art, title/artist (marquee if long), emerald scrubber, transport row = shuffle / prev / **big emerald circular play-pause (h-14)** / next / repeat — **group prev/play/next with a real gap so a Next tap can't hit play/pause**. Bottom tab bar: Home / Search / Your Library, filled icon when active, gradient-to-top black backdrop + blur.
- **Custom motion** (`styles.css`): press feedback `scale(0.985)`, route enter (fade+translateY 10px, 220ms), cover settle (fade+scale 0.965→1, 520ms ease `cubic-bezier(0.16,1,0.3,1)`), skeleton shimmer (1.25s), marquee scroll for overflowing titles, now-playing sheet slide-up (360ms in / 260ms out). Honor reduced-motion.
- **Icons** (lucide-react-native): Play, Pause, SkipBack, SkipForward, Heart, Download, Shuffle, Repeat, ListMusic, Moon (sleep), MicVocal (lyrics), ChevronDown, Podcast, RadioTower, Check, CheckCircle2, Search/Home/Library tab glyphs.

> Study `src/client/styles.css`, `src/client/pages/HomePage.tsx`, `src/components/NowPlayingSheet.tsx`, `src/components/PlayerBar.tsx`, `src/components/SongCard.tsx`, `src/components/SongListItem.tsx`, `src/components/MobileNav.tsx`, `src/client/pages/LibraryPage.tsx` for exact classes.

---

## 5. Screens (full inventory)

Bottom tabs: **Home (`/`) · Search (`/search`) · Your Library (`/library`)**. The mini-player bar + Now Playing sheet are global overlays above the tabs.

- **Home** (`HomePage.tsx`): three horizontal scrollers in order — **Discover** (Spotify Top-50, instant-play staging — see §6), **Recently played**, **Most played** (with "N plays" subtitle). Tap tile → play; tap active tile → toggle. Seeds the likes store from `/api/home` `likedSongIds` (do the equivalent so like buttons enable). Loading → "Loading library…"; sections hide when empty.
- **Search** (`SearchPage.tsx` → MobileSearch): client-side full-text over `/api/search-index`. Input + result rows (cover + title + artist), tap to play. Skeleton rows while loading.
- **Your Library** (`LibraryPage.tsx`): tappable rows — **Liked Songs** (emerald gradient card → `/liked`), **Downloads** (→ `/downloads`), **Radio Stations** (→ `/radio`), **Podcasts** (→ `/podcasts`), then **Playlists** from `/api/library` (each → `/playlist/:id`), and **Upload** (mobile). Color-coded icon squares (see tokens). Skeletons + signed-out/empty states.
- **Liked Songs** (`LikedPage.tsx`): responsive song grid from `/api/liked`. Per-card play + heart; bulk download (scope `liked`). Unliking auto-removes. Signed-out / empty states.
- **Playlist** (`PlaylistPage.tsx`): header (name, "N tracks", Download playlist) + song grid from `/api/playlist/:id`. NOTE: this is **view-only** — there is **no reorder UI** (a `playlist-reorder` offline-mutation type exists and maps to `POST /api/playlist/:id/reorder`, but nothing in the UI produces it), and "create playlist" / "add song to playlist" are **not built** (no endpoint either). Implementing any of these is a backend+UI task if desired.
- **Downloads** (`DownloadedPage.tsx`): grid from local offline DB, infinite scroll (80/page), dedup by songId. Empty/skeleton states.
- **Radio** (`RadioPage.tsx`): grid of hardcoded `RADIO_STATIONS` (HLS streams; `source:"radio"`). Live badge, accent bars, tap to play.
- **Podcasts** (`PodcastsPage.tsx`): show grid (hardcoded `PODCAST_SHOWS`) → episode list (parsed from `/api/podcast-feeds/:id` RSS; media via `/api/podcast-media/:id?url=`). Per-episode play/download/progress, "Played"/progress badges, playback-speed control (0.75–2×). `source:"podcast"`.
- **Upload** (`UploadPage.tsx`): two modes — Spotify link (single track card + batch album/playlist with progress) and file upload (title/artist/cover/audio). Posts to `/api/songs` / `/api/songs/spotify*`. Auth-gated.
- **Settings** (`SettingsPage.tsx`): Offline settings + Crossfade settings (enabled + seconds slider 0–12).
- **Profile** (`ProfilePage.tsx`): avatar (upload via `/api/profile/image`), name, email, settings link, sign out.
- **Sign In / Register** (`SignInPage.tsx`, `RegisterPage.tsx`): email+password; register also shows "check your email" verification screen.
- **Now Playing sheet** (`NowPlayingSheet.tsx`): big art (swipe L/R to change track), title/artist (marquee), scrubber (or live indicator for radio), transport row, header actions (download, like, lyrics toggle, sleep timer, queue). Podcast card with speed control. Sleep-timer bottom sheet (5/15/30/45/60 min or end-of-track).
- **Queue sheet** (`QueueSheet.tsx`): current song highlighted + "Up Next" (shuffle shows redo stack then pool); tap to jump, X to remove.

States everywhere: skeletons while loading, signed-out prompts (link to `/signin`), empty messages, red error text. Page enter animation + scroll-to-top on route change.

---

## 6. API contract (the part that stays — implement against this)

Base: `https://spotify.streamarena.xyz`. All data calls use the session cookie (`credentials:"include"`). JSON errors: `{ "error": string }` with standard status codes (401 unauth, 404, 409 duplicate-song with `{code:"DUPLICATE_SONG", existingSong}`, 413, 429 with Retry-After). GETs that go through `jsonCached` send **weak** ETags (`W/"…"`; support `If-None-Match` → 304) — note `playback-state`/`play-events`/`offline-downloads`/likes-mutations are **not** cached and carry no ETag. **Auth paths (verified in `src/client/auth.tsx`)**: `GET /api/auth/session`, `POST /api/auth/signin`, `POST /api/auth/signout` (returns **204**), `POST /api/register`, `POST /api/auth/resend-verification`, `GET /api/auth/verify/:token` (**302-redirects** to `/?verified=…` — it's a browser link, not a fetch). Note: every data GET also gets a `?auth=<userId>` cache-key query param and an `x-spotify-api-refresh` header from `api.ts`; the backend ignores both, but you inherit them if you reuse `api.ts`.

Core types (from `src/types/player.ts` + `src/client/api.ts`) — reproduce them:
```ts
type PlayerSong = {
  id: string; title: string; artist: string; album?: string;
  imageUrl: string; networkImageUrl?: string;
  audioUrl: string;             // ← signed; pass to player verbatim, prepend origin
  lyricsUrl?: string; description?: string; link?: string; createdAt?: string;
  duration?: number;            // seconds (NaN before metadata)
  audioBitDepth?: number; audioSampleRate?: number;
  source?: 'server'|'browser-local'|'picked-file'|'radio'|'podcast'|'offline';
  localPath?: string; writable?: boolean;
  staged?: boolean; discoverTrackId?: string;   // Discover
};
type HomePayload = { songs: PlayerSong[]; likedSongIds: string[] };
type StatsHomePayload = { recentlyPlayed: PlayerSong[]; mostPlayed: {song:PlayerSong; playCount:number}[] };
type LikedPayload = { songs: PlayerSong[]; likedSongIds: string[] };
type LibraryPayload = { playlists: PlaylistEntry[]; userId: string|null };
type PlaylistEntry = { id:string; name:string; imageUrl?:string|null; userId?:string; createdAt?:string; songsCount:number };
type PlaylistPayload = { playlist: {...}|null; songs: PlayerSong[]; likedSongIds: string[] };
type DiscoverTrack = { id:string; title:string; artist:string; album:string; imageUrl:string;
  durationMs:number|null; spotifyUrl:string; staged?:boolean; audioId?:string; audioUrl?:string };
type DiscoverPayload = { tracks: DiscoverTrack[] };
```

Endpoints (method → path → notes):
- **Auth/profile**: see `auth.tsx`. `POST /api/profile/image` (multipart on web; the web app sends base64 JSON on Capacitor — in RN you can use multipart via FormData).
- **Library/home**: `GET /api/home` → HomePayload. `GET /api/stats/home` → StatsHomePayload. `GET /api/search-index` → `{songs}`. `GET /api/library` → LibraryPayload.
- **Songs**: `GET /api/songs` (list), `GET /api/songs/:id`, `PATCH /api/songs/:id` (title/artist), `POST /api/songs/:id/assets` (image/lyrics), `POST /api/songs` (import: multipart upload OR JSON `{mode:"spotify", spotifyUrl, title, artist, album, durationMs, imageUrl, qualityProfile:"max", outputFormat:"flac", region, replaceExisting}` → 201/200/409).
- **Spotify import**: `POST /api/songs/spotify` (`action: "fetch"|"availability"|"lyrics"`), `POST /api/songs/spotify/batch`. (`POST /api/songs/spotify/file` exists server-side but the current client never calls it — skip unless you add a use.)
- **Likes**: `GET /api/liked` → LikedPayload. `GET /api/likes` → `{likes, likedSongIds}` (both arrays, same data). `POST /api/likes` `{songId}` / `DELETE /api/likes` `{songId}`.
- **Playlists**: `GET /api/playlist/:id` → PlaylistPayload. `POST /api/playlist/:id/reorder` `{songIds}`. (No create/add-song endpoint yet.)
- **Discover**: `GET /api/discover/trending` → DiscoverPayload (tracks with `staged`/`audioId`/`audioUrl` when ready). `POST /api/discover/stage` (blocking on-demand materialize for a not-yet-staged track → returns a playable `PlayerSong` with `staged:true, discoverTrackId`). `POST /api/discover/promote` `{trackId, finalId}` (idempotent; moves a staged track into the library so it can be liked/owned). The web "keep" flow: liking/downloading a staged track calls `/api/discover/promote` first (see `src/client/discover-keep.ts` + the intercepts in `src/store/likes.ts` / `src/client/offline.ts`).
- **Media** (signed): `GET /api/files/local/<path>?spotify_user&spotify_scope&spotify_sig` (audio/lyrics, Range-enabled), `GET /api/artwork/local/<id>?spotify_user&spotify_scope&spotify_sig` — serves the cover **as-is, no width/resize param**. Width-resizing exists only on the R2 route `GET /api/artwork/r2/<path>?w=<width>` (param is **`w`**, not `width`; R2-uploaded covers only — `CoverImage.tsx` skips it for `/api/files/local/` paths). **Stream these verbatim.**
- **Playback state (resume across devices)**: `GET/PUT /api/playback-state` → `{state: {version:1, accountScope, queue, currentIndex, song, currentTime, isPlaying, updatedAt, deviceId}}`. Last-write-wins on `updatedAt`. Publish on pause/seek/track-change + on app background.
- **Stats**: `POST /api/play-events` `{song, durationMs}` (the server reads only these; a `songId`/`deviceId`/`region` if sent are ignored) — fire when a track reaches **30 seconds OR ≥50% of its duration** (NOT "30%").
- **Offline list (server mirror)**: `GET/PUT/POST/DELETE /api/offline-downloads` exist **in the Worker**, but the current web client **never calls them** — `src/client/offline.ts` mirrors only its mutation queue (likes/reorder/edits), not the download set. So "the offline set follows the account" is **new work to build**, not behavior to port.
- **Podcasts**: `GET /api/podcast-feeds/:id` (RSS), `GET /api/podcast-media/:id?url=` (range proxy).

---

## 7. Playback & audio (the meaty part)

Reuse `src/store/player.ts` (queue/shuffle/repeat/sleep-timer/crossfade settings) and `src/types/player.ts` essentially as-is. Reuse `src/lib/crossfade-curve.ts` (equal-power cos/sin). From `src/components/PlayerBar.tsx` reuse the **scheduling/target/commit skeleton** (`computeNextTarget` / `commit` / `forceCommit`) — but its three fade *bodies* (native AVPlayer ramp, Web-Audio `GainNode` ramp, `setInterval` `audio.volume` ramp + clean-cut fallback) are fused to web primitives and are a **rewrite**, not a port (see §11). Defaults: volume 0.9, crossfade **enabled, 4s** (range 0–12), playbackRate 1 (podcast rate clamp **0.5–3** in the store; the podcast speed UI cycles **0.75–2×**), max history 200. Reusing the player store also means keeping `isMuted`/`toggleMute` and the queue-index-remap invariant — see §11. Queue is filtered to one **kind** (music/podcast/radio) per the anchor track (`src/lib/player-song.ts`).

**Base engine**: `react-native-track-player` — gives queue, background audio (`AVAudioSession .playback` equivalent + Android foreground service), **lock-screen now-playing + artwork**, **remote commands** (play/pause/next/prev/seek/headphones), rate, seek. Wire its remote events to the Zustand actions (`play/pause/next/previous/seekTo`). HLS (radio) is supported natively.

**Crossfade — choose one (in order of fidelity):**
- **(A) Faithful: a custom Expo native module** that mirrors `AudioEnginePlugin.swift` — two AVPlayer decks on iOS + two ExoPlayer instances on Android, equal-power volume ramps on a native timer, deck swap on commit. The Swift emits **9** JS events, not 6: `time`, `loaded`, `ended`, `seeked`, `error`, `crossfadeComplete`, plus **`playing`** / **`waiting`** (stall-vs-playing, from `timeControlStatus`) and **`remote`** — the entire lock-screen / Control-Center / headphone command channel (play/pause/toggle/next/prev/seek), also fired by the audio-session interruption observer to auto-pause/resume on calls & Siri. Highest effort, exact behavior, survives lock screen. The Swift is ~510 lines and is a direct template; you'd add Android.
- **(B) Pragmatic overlap: two `expo-audio`/`expo-av` `Sound` instances** for music — preload the next on deck B, ramp A down (cos) / B up (sin) over `crossfadeSeconds`, swap. Use RNTP only for lock-screen metadata/commands, or drive the lock screen yourself. Medium effort; watch background-timer throttling (schedule the ramp ahead, force-commit on `ended`).
- **(C) Simple: RNTP only**, accept a quick fade-out/fade-in (or no crossfade). Lowest effort; loses the "plays to the end while the next rises" feel the owner specifically wanted.
- Disable crossfade for: repeat-one, podcasts (rate≠1), radio (HLS, no end), and last-track. Native iOS prefetches the next deck **8s** before the fade.

**Other behaviors to keep**: prefetch/warm upcoming tracks; resume-seek injection on load; sleep timer (expire mid-track or at end); podcast progress write (~5s) + resume (≥10s); publish play-events **at 30s OR ≥50% of duration**; cross-device resume via `/api/playback-state`. **Also port the audio robustness layer in §11** (error retry/skip circuit-breaker, captured-target force-commit, seek-in-flight suppression, remote-only lock-screen artwork) — without it a single expired signed URL can silently wedge the queue.

---

## 8. Offline downloads

Reuse the model in `src/client/offline.ts` (`OfflineDownloadRecord`, pinning `DownloadScope` = `home|liked|playlist:<id>|song:<id>` with reference-counting, account scoping, the serial download pump with retry/stall-timeout, mutation queue for offline likes/edits). Swap storage:
- Files → **expo-file-system** `downloadAsync` into `documentDirectory` (`offline-media/<songId>/audio.flac|cover.jpg|lyrics.lrc`); store `file://` paths. RN plays `file://` with Range directly — **no blob materialization**.
- Records + cached API snapshots + mutation queue → **expo-sqlite** (replaces IndexedDB; keep the `[accountScope, songId]` keying + status/updatedAt indexes).
- `autoDownloadLiked`: liking queues a download (unlike unpins); enabling the toggle also **backfills existing likes** via `/api/liked`. Verify integrity on launch; repair/redownload missing files (the current launch verify/repair is **native-only**, gated on native storage — make it universal in RN).
- **(New work, not a port)** If you want the offline set to follow the account, build the sync against `/api/offline-downloads` (PUT/POST/DELETE) — those Worker routes exist but the current client never calls them (see §6). Today only the mutation queue (likes/reorder/edits) is mirrored.
- Don't forget the rest of the model (see §11): cached **API snapshots with ETags** (offline reads of `/api/home`, `/api/liked`, …), `prefetchUpcoming`, a priority queue for just-tapped downloads, in-memory record caps with paged reads, and foreign-device quarantine.

---

## 9. Auth & session

Reuse `src/client/auth.tsx` logic (sign in/out, `/api/auth/session` refresh with a ~2.5s timeout, cached user). In RN: persist the cached user in `expo-secure-store`; rely on the native cookie store for the session (RN fetch persists `Set-Cookie`). Single-owner model: the deployed user is "Erlin"; the server treats the library owner specially (the media `scope` is `"shared"` for the owner). Drop the LAN/`localhost` auto-trust and the Capacitor multipart base64 workaround.

---

## 10. Ports verbatim vs rewrite

| Reuse ~as-is | Rewrite |
|---|---|
| `src/store/player.ts`, `src/store/likes.ts` (minus DOM/localStorage) | All UI (DOM → RN components) |
| `src/types/player.ts`, `src/client/api.ts` types | Audio engine (Capacitor/AVPlayer → RNTP/expo-audio) |
| `src/lib/crossfade-curve.ts`, shuffle/repeat logic | Offline storage (IndexedDB/Cache/Capacitor FS → expo-sqlite/expo-file-system) |
| `src/client/discover-keep.ts` (keep/promote) | Navigation (react-router → expo-router) |
| API request/response shapes, signed-URL handling | `native-api.ts`/`native-network.ts` (delete), service worker, PWA manifest |

---

## 11. Omitted surfaces & robustness you must also port (don't skip)

These exist in the current app but aren't in the feature sections above. Decide explicitly to **port or drop** each — don't omit by accident.

**UI surfaces**
- **`TrackActionsMenu.tsx` — a third global bottom sheet** (alongside Now Playing + Queue). A `•••` (`MoreHorizontal`) trigger on **every** `SongCard` and `SongListItem` opens a sheet: **Play next** (`ListStart`), **Add to queue** (`ListEnd`), **Save/Remove from Liked** (`Heart`). Slide-up (260ms), swipe-down/Esc to close, focus trap. Wire to `playNext` / `addToQueue` / likes.
- **Desktop (`lg:`) surfaces — port or consciously drop:** left `LibrarySidebarClient` (collapsible nav, persisted), right `NowPlayingSidebar` (art + credits + lyrics via `LyricsPanel`), `HomeSearchCommandPalette` (header search — distinct from the `/search` route), and the desktop top header/nav. If the Expo app is phone-only, dropping these is fine — just make it a decision.
- **Global chrome:** `EmailVerificationBanner` (unverified users), `OfflineStatusIndicator` (sync/offline state), and the `*` not-found route. Skip the PWA-only bits (`InstallPrompt`, `PwaRegister`, service worker).
- **Icons beyond §4's list:** `MoreHorizontal`, `ListStart`, `ListEnd` (actions menu); `CircleArrowDown` / `RefreshCw` / `X` + custom `DownloadProgressPie` and downloaded-badge SVGs (the download affordance is **not** lucide `Download` — that glyph is only the Library "Downloads" row); `Volume2` / `VolumeX` / `ChevronUp` (volume); `LayoutGrid` / `Rows3` (grid/list toggle).
- **`OfflineSettings` is a full management UI** (storage used/quota, storage mode, Verify downloads, Clear downloads, the auto-download-liked toggle) — not the single toggle §5 implies.

**Store machinery (don't drop when porting `player.ts` / `likes.ts`)**
- Player store: `isMuted` / `toggleMute`; `replaceStagedSong` and `replaceSong` (post-promote, ref-preserving swaps); the **queue-index-remap invariant** `remapQueueIndices` (keeps history/future/shuffle-pool consistent across `playNext` / `addToQueue` / `removeFromQueue` — **silent shuffle corruption if dropped**); the crossfade-commit contracts `AdvanceToIndexOptions.fromFuture` / `preservePlayState`; the upcoming-order helpers (`getUpcomingPlaybackIndices`, shuffle pool).
- Likes store: optimistic toggle + `pending` map + **rollback**; local-song likes (`browser-local:` / `picked-file:` ids, persisted separately); the offline-mutation-queue fallback; auto-download-on-like; API-cache patching. Porting hazards inside the store itself: it does a **relative `fetch("/api/likes")`** (no origin in RN — prepend the base) and imports **Capacitor haptics** (swap to `expo-haptics`); both stores are riddled with `window` / `localStorage` probes that silently no-op in RN unless rewritten.

**Audio robustness (the invisible layer that makes crossfade survive the lock screen)**
- **Error circuit-breaker:** retry the same track once with a cache-busted URL, then skip; **stop after 3 consecutive** failures; wipe the queue on a double-404. Directly guards the headline "expired signed URL → 403" failure mode in §1.
- **Captured-target `forceCommit` on `ended`:** when the OS throttles the background JS timer, the outgoing track's `ended` commits the **captured** next target — recomputing in shuffle would draw a different random track and desync queue vs. audio.
- **Audio-session interruption handling:** auto-pause on call/Siri/alarm, auto-resume after (RNTP exposes this via `RemoteDuck`).
- **Seek-in-flight suppression:** AVPlayer reports the pre-seek position briefly after a seek — drop time events until the matching `seeked` or the scrubber flashes backward then jumps.
- **Lock-screen artwork must be a remote `http(s)` URL:** the native now-playing center can't read `blob:` / `file:` covers, so for offline tracks hand RNTP `networkImageUrl`, not the local file.
- The current Capacitor build still does `blob:` materialization + seek-recovery (`src/client/capacitor-offline.ts`); RN replaces it with `file://`, but keep the lesson: **on a non-seekable source, don't clobber the resume point.**

---

## 12. Suggested phased plan

1. **Skeleton**: Expo + expo-router + NativeWind + theme tokens; bottom tabs; an API client (base origin + cookie + signed-URL passthrough) + the TS types; a Sign In screen; fetch `/api/home`.
2. **Browse + play (no crossfade)**: Home/Library/Liked/Playlist/Search screens against the real API; RNTP queue playback of signed `audioUrl`s; mini player + Now Playing sheet; like/unlike. Prove streaming works (this validates the signed-URL plumbing).
3. **Lock screen + background + remote commands** via RNTP; play-events; playback-state resume.
4. **Crossfade** (pick A/B/C from §7) + shuffle/repeat/sleep-timer parity.
5. **Offline** (expo-file-system + expo-sqlite, pump, scopes, verify).
6. **Discover** (trending tiles, instant play from staged `audioUrl`, on-demand `stage`, keep→`promote`), **Podcasts**, **Radio**, **Upload**, **Settings/Profile**.
7. **EAS Build** for device/TestFlight.

## 13. First steps for you

Start by reading, in order: `src/types/player.ts`, `src/store/player.ts`, `src/client/api.ts`, `src/client/auth.tsx`, `src/components/PlayerBar.tsx`, `src/components/NowPlayingSheet.tsx`, `src/client/styles.css`, `src/lib/crossfade-curve.ts`, `ios/App/App/AudioEnginePlugin.swift`, and `src/server/local-music-server.ts` (the media-signing + discover routes). Then scaffold the Expo app and do Phase 1. Validate streaming early — if a non-downloaded song plays from its signed `audioUrl`, the hardest plumbing is proven.
