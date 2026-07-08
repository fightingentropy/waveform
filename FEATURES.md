# Current Spotify App Features

This app is a private Spotify-style music library for the Mac mini. The public
site is served at `https://music.streamarena.xyz` through direct Caddy, and
the music files live on the Mac mini at `/Users/hermes/Music`.

## Playback

- Streams local Mac mini tracks through direct Caddy with HTTP range support.
- Keeps FLAC as the server-side import format by default.
- Supports native browser playback for FLAC, M4A/AAC, MP3, WAV, OGG, Opus, and
  other formats the browser can decode.
- Starts playback inside the original click/keyboard gesture so browser
  autoplay protections do not block normal play actions.
- Uses a persistent dual-audio player for crossfade and seamless source changes.
- Supports shuffle, repeat, previous/next, seeking, volume, mute, media-session
  controls, and resume position.
- Prefetches nearby playback assets and upcoming tracks for faster starts.

## Library

- Scans `/Users/hermes/Music` on the Mac mini and builds the app library from
  audio files plus `.spotify.json` sidecars.
- Reads embedded metadata, local sidecar metadata, cover files, embedded cover
  art, and lyrics files when present.
- Uses remote artwork lookup as a fallback when local or embedded art is
  missing.
- Provides Home, Search, Liked Songs, Downloads, Radio Stations, Upload,
  Library, Settings, and Profile routes.
- Shows built-in library collections separately from custom playlists.
- Displays existing custom playlists from the Worker/D1 backend when present.
- Supports playlist reordering for existing custom playlists, including offline
  mutation queueing.

## Import And Upload

- Manual uploads accept audio files plus optional title, artist, cover art, and
  lyrics.
- Spotify import accepts track, album, playlist, and Liked Songs URLs.
- Liked Songs import requires a Spotify `sp_dc` cookie.
- Provider selection supports Auto, Qobuz, and Tidal.
- Quality profiles are CD quality, 24-bit/48 kHz, and max available.
- Server imports save FLAC/original audio to the Mac mini music folder.
- Imports can include synchronized LRC lyrics when available, with plain-text
  fallback.

## Offline

- Songs, liked songs, playlists, artwork, and lyrics can be downloaded for
  offline playback on the current device.
- Offline API snapshots allow cached pages to open while offline after they have
  been visited once.
- Like changes, playlist reorders, and metadata/asset edits can queue offline
  and sync later.
- Settings includes storage usage, quota, persistent-storage status, retry,
  manual sync, playback-cache clearing, and download clearing.

## Settings

- Playback: crossfade on/off and duration from 0 to 12 seconds.
- Offline: local download/cache management and sync status.
- Downloads: provider and quality profile.
- Operational controls and internal status panels are intentionally kept out of
  normal app chrome.

## Production Architecture

- Public app: `https://music.streamarena.xyz`
- Mac mini Tailscale app/server: `http://100.121.144.60:5174`
- Mac mini LAN app/server: `http://192.168.1.240:5174`
- Operational scripts try the Tailscale SSH alias/IP first, then fall back to
  the LAN SSH alias/IP.
- Worker backend: `https://spotify.erlinhoxha.workers.dev`
- Music server launchd service: `xyz.streamarena.spotify-app`
- Shared Caddy launchd service: `xyz.streamarena.caddy`
- DNS drift watcher launchd service: `xyz.streamarena.spotify-dns-watch`

Caddy serves the frontend and direct media routes from the Mac mini. Browser API
requests for auth/import/library metadata go to the Worker backend, and trusted
Worker-to-Mac-mini requests use `MAC_MINI_PROXY_TOKEN` and `SPOTIFY_PROXY_TOKEN`.

## Operational Checks

- `bun run mini:check` verifies the Mac mini server, launchd state, scan count,
  and direct Mini reachability.
- `bun run mini:install-caddy` installs or refreshes the direct Caddy route.
- `bun run mini:install-dns-watch` installs or refreshes the DNS drift watcher.
- Live media health should include a `206` response for FLAC range requests.
- DNS watch logs should show `dns_ok` in
  `/Users/hermes/.local/state/spotify/dns-watch.log`.
