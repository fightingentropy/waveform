# Spotify → Expo / React Native port — status

This `mobile/` app is a fresh **Expo (SDK 56) / React Native** client for the existing
self-hosted Spotify backend (`https://music.streamarena.xyz`). The backend is
**unchanged**; this is a new native client against the same HTTP API. Built per
`docs/EXPO_PORT_PROMPT.md`; reconstruction notes for the original app live in
`docs/port-notes/`.

> ✅ **Builds AND runs on the iOS Simulator** (verified 2026-06-14, Xcode 26.5,
> iPhone 17 / iOS 26.5, New Architecture on). `npx expo prebuild` → `pod install`
> (CocoaPods 1.16.2 via Homebrew) → `xcodebuild … -sdk iphonesimulator` →
> **`** BUILD SUCCEEDED **`**. Installed + launched: JS bundle loads (3855 modules),
> Home/Discover renders with **live backend data + signed-URL album art**, tab
> navigation works (Home/Search/Library), Search shows its empty-state (the
> `/api/search-index` is user-scoped, so it's empty until you sign in), and **audio
> plays end-to-end via RNTP** — tapping a Discover track started playback ("stupid
> song" — Olivia Rodrigo), the mini-player bound to player state, and the play/pause
> transport toggled correctly. No redbox; the only warnings are RNTP's unused native
> sleep-timer methods (this app drives the sleep timer from JS, so they're harmless).
>
> ⚠️ **Still untested:** physical device + EAS cloud build (no Apple account here);
> anything behind login (Liked / Library / playback-state sync / uploads) since the
> sim session isn't authenticated; lock-screen/Control-Center remote controls and
> background audio (needs a device); offline downloads. Native-dependency versions
> (RNTP, MMKV, gorhom, svg, slider…) were pinned via `expo install`.

## Stack

Expo SDK 56 · Expo Router (file-based) · NativeWind v4 (Tailwind classes) · Zustand ·
react-native-track-player (audio/lock-screen/remote) · react-native-mmkv (sync settings)
· expo-sqlite + expo-file-system (offline) · @gorhom/bottom-sheet (sheets) ·
reanimated + gesture-handler · lucide-react-native · expo-image · expo-haptics.

## What's implemented

**Core logic — ported ~verbatim** (`src/store`, `src/lib`, `src/types`):
- `store/player.ts`, `store/likes.ts` — full logic incl. the queue-index-remap invariant,
  shuffle/repeat, optimistic likes + rollback, staged-Discover promote-before-like.
  `localStorage` → synchronous MMKV; relative `fetch` → origin-aware `apiFetch`; Capacitor
  haptics → `expo-haptics`.
- `lib/crossfade-curve.ts` (`equalPowerGain`), `lib/player-song.ts`, `lib/discover-keep.ts`,
  `types/player.ts`.
- `lib/api.ts` — cache + weak-ETag/304 + in-flight dedup + timeout + `patchLikeApiCache` +
  `useApiData`; web-only `navigator`/serviceWorker/Cache-API branches removed; offline
  snapshots persisted to MMKV; auth-required signal via an event bus.
- `lib/auth.tsx` — `AuthProvider` (session refresh w/ 2.5s timeout, cached user, forced
  logout, generation guard). LAN auto-trust + Capacitor base64 upload dropped (§9).
- `lib/config.ts` — API origin + **signed-URL passthrough** (`toAbsoluteApiUrl` only
  prepends the origin; never re-encodes the `spotify_sig` query — §1).

**Audio** (`src/audio`): RNTP setup + playback service (remote/lock-screen/headphone →
store), an imperative engine syncing the store to RNTP, **signed `audioUrl` passthrough**,
play-events (30s OR ≥50%), cross-device `playback-state` publish/restore, sleep timer (+8s
watchdog), podcast resume(≥10s)/progress(~5s), repeat-one, and the robustness layer:
error circuit-breaker (cache-bust retry → skip → stop@3), double-404 queue wipe,
RemoteDuck interruption pause/resume, **remote-only lock-screen artwork**.

**Screens** (`src/app`): Home (Discover + on-demand `stage`, Recently/Most played),
Search (client-side over `/api/search-index`), Library, Liked, Playlist (view-only),
Downloads, Radio, Podcasts (RSS parsed in-app) + episodes, Upload (Spotify link + file),
Settings (crossfade + auto-download), Profile, Sign In / Register. Global mini-player,
Now Playing sheet (swipe-to-change-track, transport with the deliberate prev/play/next
gap, lyrics toggle, podcast speed), Queue sheet, Track-Actions sheet, Sleep-timer sheet.
Design tokens match `src/client/styles.css` (two-greens rule respected: `#1ed760` on Home
scrollers, emerald `#10b981` on grid cards / transport / likes).

**Offline** (`store/offline.ts` + `lib/offline-db.ts`): expo-sqlite records,
expo-file-system `file://` downloads, ref-counted scopes (`home|liked|playlist:|song:`),
account scoping, serial download pump, hydrate-on-launch + resume, offline playback
resolution (swaps in `file://`, keeps remote artwork for the lock screen), and
`autoDownloadLiked` backfill via `/api/liked`.

## Crossfade

Shipped as **Option C** (RNTP, single-player): on track end the store advances and the next
track loads; no true equal-power overlap. `equalPowerGain` + `computeNextTarget` semantics
are preserved in the store for the upgrade path. **Option A (faithful dual-deck)** requires
a custom Expo native module mirroring `ios/App/App/AudioEnginePlugin.swift` — full template
(9 events, dual AVPlayer decks, native ramp, remote channel, interruptions) is documented in
`docs/port-notes/native-swift-engine.md`. Build it as an Expo Module and route the engine's
load/commit through it to get the "plays to the end while the next rises" behavior.

## Known limitations / remaining work

- **Not device-tested**; native crossfade module (Option A) not built.
- **Session cookie**: relies on RN's native cookie jar persisting `Set-Cookie` (per §2).
  One port-notes reviewer flagged this can be unreliable; `@react-native-cookies/cookies`
  is installed as a fallback if you need to capture/replay `spotify_session` manually.
- **Offline-set-follows-account** sync against `/api/offline-downloads` is **not** built
  (it's new work, not a port — §8). The offline mutation outbox is persisted but not yet
  replayed on reconnect (hook `queueOfflineMutation` → a flush on NetInfo `online`).
- **Desktop (`lg:`) surfaces consciously dropped** (phone-only): left sidebar, right
  Now-Playing sidebar, command palette, top header.
- Lyrics render statically (no time-sync highlight yet); marquee omits the CSS edge-fade
  mask; sub-pages (playlist/liked/…) hide the mini-player while open (pushed above the tabs).
- React Compiler experiment disabled for first-build safety (`app.json`).

## Run it

```bash
cd mobile
npm install --legacy-peer-deps        # already installed in this checkout
brew install cocoapods                 # required for the iOS build; brew's formula bundles its
                                       #   own Ruby (system Ruby 2.6 is too old). Already installed here.

# Simplest path — builds, installs, launches, starts Metro:
npx expo run:ios                       # RNTP/MMKV/etc. need a dev client, NOT Expo Go

# or Android:  npx expo run:android    (needs the Android SDK)
# or EAS (no local 7-day re-sign):  eas build --profile development --platform ios
```

`ios/` is already prebuilt in this checkout (`npx expo prebuild` + `pod install` done).
The exact commands that produced the verified simulator build:

```bash
cd mobile/ios
xcodebuild -workspace Spotify.xcworkspace -scheme Spotify -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build CODE_SIGNING_ALLOWED=NO build
xcrun simctl boot "iPhone 17"
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/Spotify.app
npx expo start                         # (from mobile/) Metro on :8081
xcrun simctl launch booted xyz.streamarena.spotify
```

Override the backend origin via `app.json` → `expo.extra.apiOrigin` if needed.
