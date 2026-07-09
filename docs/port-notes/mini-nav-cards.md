# Port Notes — Mini Player, Bottom Tab Bar & Song Cards

Source app: Vite + React 19 + Tailwind v4 + Zustand, wrapped in Capacitor.
Target: fresh Expo / React Native app (NativeWind).

Scope of this file (7 components):
- `src/components/MobileNav.tsx` — bottom tab bar (Home / Search / Library)
- `src/components/PlayerBar.tsx` — **only the mobile mini-player bar** (the bottom mini bar render). The desktop player + the giant audio-engine logic are out of scope here, but noted as hazards.
- `src/components/SongCard.tsx` — grid card with floating circular play button
- `src/components/SongListItem.tsx` — list row
- `src/components/SongGrid.tsx` — grid/list container, toggle, header controls, virtualization
- `src/components/CoverImage.tsx` — `<img>` with fallback chain + responsive srcSet
- `src/components/OfflineDownloadButton.tsx` — download affordance (pie + badge SVGs)

Shared helper: `cn(...inputs)` = `twMerge(clsx(inputs))` (from `src/lib/utils.ts`). In RN/NativeWind replace with `clsx`/`tailwind-merge` or NativeWind's own merge; **tailwind-merge dedup behaviour matters** because some components rely on later classes winning (see DownloadedBadge note).

---

## 0. The two-greens rule (CRITICAL color invariant)

There are TWO distinct greens used for the floating play affordances, and they MUST be preserved exactly:

| Context | Green | Where |
|---|---|---|
| **Home scroller / SongGrid header play button / shuffle-active / mini-player liked heart & repeat-active** | `#1ed760` (Spotify green) | `SongGrid` header play button `bg-[#1ed760]`, hover `bg-[#1fdf64]`; shuffle dot/active `bg-[#1ed760]` / `text-[#1ed760]`; mini-player liked heart container `text-[#1ed760]` |
| **Grid `SongCard` + list `SongListItem` floating circular play button, active-row tints, ring** | `emerald-500` = **`rgb(16, 185, 129)`** (`#10b981`) | `SongCard` play disc `bg-emerald-500`; `SongListItem` play disc `bg-emerald-500`; active ring `ring-emerald-500`; active row bg `bg-emerald-500/10`; active title `text-emerald-500` |

Notes:
- `emerald-500` is Tailwind's token; its literal RGB is `rgb(16,185,129)` / hex `#10b981`. In NativeWind you can keep `bg-emerald-500` if the emerald palette is configured, otherwise hardcode `#10b981`.
- `#1ed760` is a literal arbitrary value, NOT a palette token. Keep it as a literal.
- The `Heart` icon when liked uses `fill-emerald-500 text-emerald-500` on the icon itself, but its container uses `text-[#1ed760]`. So the liked heart is emerald-filled but sits in a `#1ed760` container — in practice the icon fill (`fill-emerald-500`) dominates the glyph color. **Reproduce both**: icon `fill=#10b981 stroke=#10b981`.
- The `DownloadedBadge` SVG hardcodes `fill="#10b981"` (emerald) + check stroke `#04140d` deliberately (see §6).

---

## 1. CSS tokens & shared `wf-*` classes (from `src/client/styles.css`)

These are referenced by the components and must be recreated as RN styles / NativeWind utilities.

CSS variables (`:root`):
```
--background: #0a0a0a;
--foreground: #ededed;
--wf-left-sidebar-width: 16rem;
--wf-mobile-nav-height: 3.25rem;          /* 52px — bottom tab bar height */
--wf-mobile-player-height: 4.25rem;       /* 68px — mini player height */
--wf-mobile-player-reserve-height: 0px;   /* becomes player-height when body.wf-has-mobile-player */
--wf-mobile-bottom-gutter: env(safe-area-inset-bottom, 0px);  /* -> RN: useSafeAreaInsets().bottom */
--wf-mobile-nav-bottom-offset: calc(nav-height + bottom-gutter);  /* mini-player sits this far up from screen bottom */
color-scheme: dark;
```
`color-background` / `color-foreground` exposed to Tailwind via `@theme inline` so `bg-background`, `text-foreground` work. `--font-sans` = system UI stack.

`body.wf-has-mobile-player` sets `--wf-mobile-player-reserve-height: var(--wf-mobile-player-height)` — i.e. when a song is loaded, the scroll area reserves room for the mini player. **PORT:** this is a global body-class toggle (set elsewhere when a song exists). In RN, instead conditionally pad the scroll content / tab content by `68 + 52 + safeArea.bottom` when a track is active.

`.wf-main` (the scroll container): `padding-bottom: calc(nav-height + player-reserve-height + bottom-gutter)`. On desktop (`min-width:1024px`) it becomes `position:fixed` between sidebars. **PORT:** RN ScrollView/FlatList contentContainer bottom padding.

`body.wf-now-playing-open { overflow: hidden }` — scroll lock when Now Playing sheet open. **PORT:** RN sheet handles this natively; ignore.

Animation/interaction utility classes (all are transitions — in RN re-implement with `Pressable` + `Animated`/Reanimated press scale, or just drop):
```
.wf-pressable        -> transform/bg/border/shadow/opacity 160ms ease; :active scale(0.985)
.wf-control-button   -> transform/bg/color/shadow/opacity 160ms ease; :active scale(0.985)
.wf-song-card        -> box-shadow 0 12px 28px rgba(0,0,0,0); transform/shadow/filter 220ms cubic-bezier(.2,.8,.2,1); :active scale(0.985)
.wf-list-row         -> bg/opacity 170ms ease (NO active scale — explicitly excluded)
.wf-song-cover       -> (no rule found; purely a hook class, safe to treat as no-op styling)
.wf-skeleton / ::after -> shimmer loader (1.25s)
.wf-route-surface    -> route enter animation 220ms
```
`@media (prefers-reduced-motion: reduce)` collapses all of these to 1ms. **PORT:** honor `AccessibilityInfo.isReduceMotionEnabled()`.

`.touch-manipulation { touch-action: manipulation }` — web-only; RN no-op.

---

## 2. `MobileNav.tsx` — bottom tab bar

### Tree
```
<nav aria-label="Main navigation" class="...gradient+blur...">
  <div class="h-[var(--wf-mobile-nav-height)] grid grid-cols-3">
    {tabs.map(tab =>
      <Link to={tab.href} onClick={selectionTap} class="...active/inactive color...">
        <tab.Icon active={active} />            // 24x24 SVG, currentColor
        <span class="text-[10px] font-medium">{tab.label}</span>
      </Link>
    )}
  </div>
</nav>
```

### Verbatim classNames
- `<nav>`: `lg:hidden fixed inset-x-0 bottom-0 z-40 text-white pb-[var(--wf-mobile-bottom-gutter)] bg-gradient-to-t from-black via-black/[0.85] to-black/[0.38] backdrop-blur-md`
  - **Gradient backdrop + blur**: vertical gradient bottom→top: `from-black` (solid) → `via-black/[0.85]` → `to-black/[0.38]`; plus `backdrop-blur-md`.
  - `pb-[var(--wf-mobile-bottom-gutter)]` = safe-area bottom padding.
  - `lg:hidden` — only shown on mobile (<1024px). RN: always show (no desktop).
- inner row: `h-[var(--wf-mobile-nav-height)] grid grid-cols-3` (height 52px, 3 equal columns).
- each `<Link>`: `cn("wf-control-button flex flex-col items-center justify-center gap-1 min-h-[44px] touch-manipulation transition-colors", active ? "text-white" : "text-[#b3b3b3]")`
  - active tab color: **white** (`text-white`); inactive: **`#b3b3b3`** (Spotify grey).
  - `min-h-[44px]` — minimum tap target.
- label: `text-[10px] font-medium`.

### Tabs config (order fixed)
1. `{ href:"/", label:"Home", Icon: HomeTabIcon, match: path === "/" }`
2. `{ href:"/search", label:"Search", Icon: SearchTabIcon, match: path.startsWith("/search") }`
3. `{ href:"/library", label:"Your Library", Icon: LibraryTabIcon, match: path.startsWith("/library") || startsWith("/liked") || "/downloads" || "/radio" || "/podcasts" || "/playlist" }`

**Note:** label for the third tab is literally `"Your Library"` (not "Library").

### Icons — Spotify Encore (24px grid, `fill="currentColor"`, outline at rest / filled when active)
All three are inline `<svg viewBox="0 0 24 24" width=24 height=24 fill="currentColor" aria-hidden>`. **Filled-when-active is achieved by swapping the `<path>` data**, not by toggling a fill prop. Exact path data (copy verbatim into RN `react-native-svg`):

**HomeTabIcon** — active:
`M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6h4v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33z`
HomeTabIcon — inactive:
`M12.5 3.247a1 1 0 0 0-1 0L4 7.577V20h4.5v-6a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v6H20V7.577l-7.5-4.33zm-2-1.732a3 3 0 0 1 3 0l7.5 4.33a2 2 0 0 1 1 1.732V21a1 1 0 0 1-1 1h-6.5a1 1 0 0 1-1-1v-6h-3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.577a2 2 0 0 1 1-1.732l7.5-4.33z`

**SearchTabIcon** — always renders this path:
`M10.533 1.279c-5.18 0-9.407 4.14-9.407 9.279s4.226 9.279 9.407 9.279c2.234 0 4.29-.77 5.907-2.058l4.353 4.353a1 1 0 1 0 1.414-1.414l-4.344-4.344a9.157 9.157 0 0 0 2.077-5.816c0-5.14-4.226-9.28-9.407-9.28zm-7.407 9.279c0-4.006 3.302-7.28 7.407-7.28s7.407 3.274 7.407 7.28-3.302 7.279-7.407 7.279-7.407-3.273-7.407-7.28z`
…and when active ALSO renders `<circle cx="10.533" cy="10.558" r="4.75" />` (a filled dot inside the magnifier).

**LibraryTabIcon** — active:
`M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z`
LibraryTabIcon — inactive:
`M14.5 2.134a1 1 0 0 1 1 0l6 3.464a1 1 0 0 1 .5.866V21a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1V3a1 1 0 0 1 .5-.866zM16 4.732V20h4V7.041l-4-2.309zM3 22a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1zm6 0a1 1 0 0 1-1-1V3a1 1 0 0 1 2 0v18a1 1 0 0 1-1 1z`

### Interactions
- Tap a tab → `selectionTap()` haptic (fire-and-forget `void`) + `react-router` navigation. **PORT:** replace `Link`/`useLocation` with React Navigation; replace haptic with `expo-haptics` `selectionAsync()`.
- Data source: `useLocation().pathname` for active state.
- No loading/empty/error/signed-out states — always rendered (gated only by `lg:hidden`).

### Porting hazards (MobileNav)
- `react-router-dom` (`Link`, `useLocation`) → React Navigation.
- `backdrop-blur-md` over a gradient → RN needs `expo-blur` `<BlurView>` + a `LinearGradient` overlay; NativeWind has no backdrop-blur.
- `bg-gradient-to-t` → `expo-linear-gradient`.
- `env(safe-area-inset-bottom)` → `react-native-safe-area-context`.
- `selectionTap()` imports `@capacitor/haptics` lazily and no-ops unless `isNativeCapacitorApp()` → replace with `expo-haptics`.

---

## 3. `PlayerBar.tsx` — mobile mini-player bar ONLY

The file is ~2900 lines; **only the mobile mini-bar render block (lines ~2557–2616) is in scope**. The rest is the dual-`<audio>` crossfade audio engine, HLS, Web-Audio gain nodes, native AVPlayer adapter, playback-state sync, sleep timer, and the desktop player — all major rewrites for RN (flagged at the end).

### When it renders
- The whole player returns `null` if `!playbackSong` (`{!playbackSong ? null : (...)}`). `playbackSong = currentSong ? resolveOfflinePlaybackSong(currentSong) : null`. So the mini bar only exists once a track is set.
- Above the bar (conditionally mounted): `NowPlayingSheet` (lazy) and `QueueSheet` (lazy), shown via `nowPlayingMounted` / `queueSheetMounted` flags with open/close animation timers (380ms close delay).

### Container wrapper (shared with desktop)
`<div className="fixed inset-x-0 z-40 border-t border-white/[0.12] bg-background text-white bottom-[var(--wf-mobile-nav-bottom-offset)] lg:bottom-0">`
- Mobile: pinned at `bottom-[var(--wf-mobile-nav-bottom-offset)]` (i.e. ABOVE the tab bar). Desktop: `lg:bottom-0`.
- `border-t border-white/[0.12]`, `bg-background` (`#0a0a0a`), `text-white`, `z-40`.

### Mini player tree (verbatim)
```
<div class="lg:hidden relative">                              // mobile-only wrapper

  {/* thin progress line across the very top of the mini bar */}
  <div class="absolute inset-x-0 top-0 h-0.5 bg-white/[0.12]" aria-hidden>
    <PlaybackProgressFill duration={duration} isRadio={currentSongIsRadio}
       class="h-full bg-emerald-500 transition-[width] duration-150" />
  </div>

  <div class="h-[var(--wf-mobile-player-height)] px-3 flex items-center gap-3">

    {/* cover + title/artist — tap opens Now Playing */}
    <button type="button" onClick={openNowPlaying}
       class="wf-pressable flex items-center gap-3 min-w-0 flex-1 text-left touch-manipulation"
       aria-label="Open now playing">
      <CoverImage src={playbackSong.imageUrl || "/apple-icon.png"}
         networkSrc={playbackSong.networkImageUrl} alt="" width={48} height={48}
         loading="eager"
         class="wf-song-cover w-12 h-12 rounded-md object-cover shrink-0" sizes="48px" />
      <div class="min-w-0">
        <MarqueeText text={playbackSong.title}
           class="text-[15px] font-medium leading-5 text-white" />
        <div class="text-[13px] leading-5 text-white/[0.62] truncate">{playbackSong.artist}</div>
      </div>
    </button>

    {/* heart — hidden for radio & podcast */}
    {!currentSongIsRadio && !currentSongIsPodcast ? (
      <button type="button"
         aria-label={songIsLiked ? "In liked songs" : "Save to liked songs"}
         onClick={handleToggleLike}
         disabled={!likesHydrated || likePending || !currentSongId}
         class={cn("wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation shrink-0",
                   likePending ? "opacity-60" : "",
                   songIsLiked ? "text-[#1ed760]" : "text-white/[0.68]")}>
        <Heart size={20} class={cn(songIsLiked && "fill-emerald-500 text-emerald-500")} />
      </button>
    ) : null}

    {/* play / pause */}
    <button type="button" aria-label={isPlaying ? "Pause" : "Play"}
       onClick={handleTogglePlayback}
       class="wf-control-button h-11 w-11 rounded-full grid place-items-center bg-white text-black touch-manipulation shrink-0">
      {isPlaying ? <Pause size={20} /> : <Play size={20} class="translate-x-[1px]" />}
    </button>

  </div>
</div>
```

### Verbatim classNames & exact values
- Wrapper: `lg:hidden relative`
- Top progress track: `absolute inset-x-0 top-0 h-0.5 bg-white/[0.12]` (h-0.5 = 2px, 12% white).
- Progress fill: `h-full bg-emerald-500 transition-[width] duration-150` (emerald = `#10b981`). Width is `${pct}%` inline style. Radio → 100%.
- Bar row: `h-[var(--wf-mobile-player-height)]` (68px) `px-3 flex items-center gap-3`.
- Cover+meta button: `wf-pressable flex items-center gap-3 min-w-0 flex-1 text-left touch-manipulation`.
- Cover image: `wf-song-cover w-12 h-12 rounded-md object-cover shrink-0`, 48×48, eager.
- Title (`MarqueeText`): `text-[15px] font-medium leading-5 text-white`. (15px, leading 20px.)
- Artist: `text-[13px] leading-5 text-white/[0.62] truncate`.
- Heart button: base `wf-control-button h-11 w-11 rounded-full grid place-items-center touch-manipulation shrink-0`; `+ opacity-60` when `likePending`; color `text-[#1ed760]` when liked else `text-white/[0.68]`.
- Heart icon when liked: `fill-emerald-500 text-emerald-500` (size 20).
- Play/pause button: `wf-control-button h-11 w-11 rounded-full grid place-items-center bg-white text-black touch-manipulation shrink-0` — **white circle, black icon**. Play glyph nudged `translate-x-[1px]` (optical centering).

### Data sources / store (Zustand)
- `usePlayerStore` selectors used in mini bar: `currentSong`, `isPlaying`, plus actions `play`, `pause`. `playbackSong` derived via `resolveOfflinePlaybackSong(currentSong)`.
- `currentSongIsRadio` = `isRadioSong(playbackSong)`, `currentSongIsPodcast` = `isPodcastSong(playbackSong)` (heart hidden for both).
- Likes from `useLikesStore`: `toggleLike`, `likedSongIds` lookup, `pending`, `hydrated`. `songIsLiked = !!likedLookup[currentSongId]`; `likePending = !!pendingLookup[currentSongId]`.
- `duration` is local React state fed by the audio engine; `PlaybackProgressFill` subscribes to `subscribePlaybackPosition(...)` for a 4Hz `currentTime` (NOT React state — a leaf subscription to avoid re-rendering the whole bar).

### Interactions
- **Tap cover/title area** → `openNowPlaying()` (animates the Now Playing sheet up via rAF + mount/unmount with 380ms close delay). This is the primary "tap opens Now Playing" gesture.
- **Tap heart** → `handleToggleLike()`: guarded by `!currentSongId || !likesHydrated || likePending || currentSongIsRadio || currentSongIsPodcast`. Calls `toggleLike(id, !songIsLiked, currentSong)`; on `401` → `navigate("/signin")`.
- **Tap play/pause** → `handleTogglePlayback()`: `impactLight()` haptic; if playing → `pause()`; else `ensureWebAudioGraph()` (iOS gesture requirement) + `requestImmediatePlayback(playbackSong)` + `play()`.
- No swipe on the mini bar itself (swipe-to-dismiss lives in NowPlayingSheet, out of scope).

### `PlaybackProgressFill` (leaf component, lines 2873–2887)
```
const [time, setTime] = useState(0);
useEffect(() => subscribePlaybackPosition(({currentTime}) => setTime(currentTime)), []);
const seekable = duration > 0 && Number.isFinite(duration);
const pct = isRadio ? 100 : seekable ? clamp((min(time,duration)/duration)*100, 0..100) : 0;
return <div className={className} style={{ width: `${pct}%` }} />;
```
**PORT:** subscribe to your RN playback-position emitter; animate width.

### Porting hazards (mini player)
- **HUGE**: this component owns the audio engine — `HTMLAudioElement` x2, Web Audio `AudioContext`/`GainNode` crossfade, `hls.js`, `navigator.serviceWorker` media cache, `MediaSession`, Capacitor native AVPlayer adapter, `blob:`/`capacitor:`/`file:` URL handling, `localStorage` playback-state, `window`/`document` event listeners. **None of this ports** — rebuild on `expo-av`/`expo-audio` or `react-native-track-player` (handles lock-screen controls, background audio, queue, crossfade-ish).
- `resolvePlayableSrc` uses `location.origin` + relative `/api/...` URLs → must become absolute base-URL fetches in RN.
- `fixed`/`z-40`/custom-bottom-offset positioning → RN absolute-positioned bar above the tab navigator, or part of a custom tab bar.
- `MarqueeText` is a web auto-scrolling text component → reimplement (e.g. `react-native-text-ticker`).
- `lucide-react` icons (`Heart`, `Play`, `Pause`) → `lucide-react-native`.
- Haptics via `@capacitor/haptics` → `expo-haptics`.
- `requestImmediatePlayback` dispatches a custom `window` event (`PLAYBACK_GESTURE_EVENT`) consumed by the audio effect → replace event bus with a direct store action / track-player call.

---

## 4. `SongCard.tsx` — grid card + floating circular play button

### Tree
```
<div onPointerEnter={warmPlaybackSong} class={cn(card-base, isActive && ring)}>
  <button (full-cover invisible play hit area) />              // absolute inset-0
  <CoverImage fill ... />
  <div class="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />   // scrim
  {showDownload && <OfflineSongDownloadButton .../>}            // top-left
  <TrackActionsButton .../>                                     // top-right (3-dots menu)
  <div (bottom overlay: title/artist + floating play disc)>
    <div> title + artist </div>
    <div (play disc wrapper, opacity logic)>
      <div class="...bg-emerald-500..."> Pause|Play </div>
    </div>
  </div>
</div>
```

### Verbatim classNames
- Card root: `cn("wf-song-card wf-pressable group relative aspect-square rounded-lg overflow-hidden bg-black/5 dark:bg-white/5", isActive && "ring-2 ring-emerald-500")`
  - `aspect-square`, `rounded-lg`, base bg `bg-black/5 dark:bg-white/5`. Active → `ring-2 ring-emerald-500`.
- Full-cover play button: `absolute inset-0 z-10 rounded-lg cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500`
  - `aria-label` = `Pause ${title}` / `Play ${title}`; `aria-pressed={isActiveAndPlaying}`.
- CoverImage props: `fill sizes="(max-width: 640px) 100vw, (max-width: 1024px) 33vw, 200px" className="wf-song-cover object-cover" priority loading={priority?"eager":"lazy"}`.
- Scrim: `absolute inset-0 bg-gradient-to-t from-black/60 to-transparent`.
- Download button wrapper class (passed to `OfflineSongDownloadButton`): `wf-control-button absolute left-2 top-2 z-30 bg-black/40 text-white/90 backdrop-blur hover:bg-black/60`.
- TrackActions (3-dots) class: `absolute right-2 top-2 z-30 h-9 w-9 text-white/90 bg-black/40 backdrop-blur hover:bg-black/60`.
- Bottom overlay row: `pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex items-end justify-between gap-2`.
- Title block: `text-left min-w-0 flex-1`; title `text-white font-medium drop-shadow truncate`; artist `text-white/80 text-xs drop-shadow truncate`.
- Play-disc opacity wrapper: `cn("transition-opacity shrink-0", isActive ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100")`
  - **Behaviour:** on small screens the disc is always visible (`opacity-100`); on `sm+` it's hidden (`sm:opacity-0`) until hover (`sm:group-hover:opacity-100`), or always visible if active. **PORT note:** RN has no hover; just always show (mobile behaviour).
- **Floating circular play button (the green disc)**: `wf-control-button h-10 w-10 rounded-full bg-emerald-500 text-white grid place-items-center` → **40×40, emerald `#10b981`, white icon**. Icon: `isActiveAndPlaying ? <Pause size={18} /> : <Play size={18} />`.

### Props (defaults)
`song`, `songIndex?`, `onPlayAt?(index)`, `liked=false`, `likePending=false`, `canLike=false`, `hideIfUnliked=false`, `onToggleLike?`, `showLike=true`, `showQueue=true`, `showDownload=true`, `priority=false`.
Returns `null` early if `hideIfUnliked && !liked`.

### Store / data
- `usePlayerStore`: `setSong`, `play`, `pause`; `isActive = currentSong?.id === song.id`; `isActiveAndPlaying = isActive && isPlaying`.
- `useOfflineStore`: `records[song.id]` → `resolvedSong = resolveOfflinePlaybackSong(song)` (swaps in offline file URL / cover when downloaded).
- `CoverImage` shows `resolvedSong.imageUrl` with `networkSrc={resolvedSong.networkImageUrl}` fallback.

### Interactions
- `onPointerEnter` / `onFocus` → `warmPlaybackSong(resolvedSong, true)` (prefetch). **PORT:** drop or trigger on press-in.
- `handlePlay`:
  - if `isActive`: `isActiveAndPlaying ? pause() : (requestImmediatePlayback(resolvedSong); play())`.
  - else if `songIndex` + `onPlayAt`: `requestImmediatePlayback(resolvedSong); onPlayAt(songIndex)` (sets queue at index).
  - else: `requestImmediatePlayback(resolvedSong); setSong(song); play()`.
- `memo` with custom prop comparator (compares all props incl. `song`, `songIndex`, `liked`, etc. by reference/value).

### Hazards
- `aspect-square` → RN: compute square via `onLayout` width, or `aspect-ratio` style (RN 0.71+ supports `aspectRatio`).
- `group-hover` / `sm:` breakpoints → no hover on RN; default to always-visible disc.
- `backdrop-blur` on the corner buttons → `expo-blur` or drop.
- `drop-shadow` on text → RN `textShadow*` style.
- `bg-gradient-to-t` scrim → `expo-linear-gradient`.
- `warmPlaybackSong` / `requestImmediatePlayback` use web fetch + custom events.

---

## 5. `SongListItem.tsx` — list row

### Tree
```
<div onPointerEnter={warm} class={cn(row-base, isActive ? activeBg : hoverBg)}>
  <button (play, flex-1, holds cover + title/artist)>
    <span (relative 48px cover wrapper)><CoverImage fill .../></span>
    <span (title/artist)>
      <span (title, active->emerald)>{title}</span>
      <span (artist)>{artist}</span>
    </span>
  </button>
  {showDownload && <OfflineSongDownloadButton .../>}
  {isActive && <div (now-playing disc) >Pause|Play</div>}    // ONLY on active row
  <TrackActionsButton .../>
</div>
```

### Verbatim classNames
- Row root: `cn("wf-list-row group flex items-center gap-3 px-3 py-2", isActive ? "bg-emerald-500/10 rounded-lg" : "hover:bg-black/5 hover:dark:bg-white/5 rounded-lg")`
  - Active row tint: `bg-emerald-500/10` (emerald @ 10%).
- Play button: `wf-pressable flex min-w-0 flex-1 items-center gap-3 rounded-md bg-transparent text-left focus:outline-none`. `aria-label`/`aria-pressed` as in SongCard.
- Cover wrapper span: `relative h-12 w-12 shrink-0 overflow-hidden rounded` (48×48, `rounded`).
- CoverImage: `fill sizes="48px" className="wf-song-cover object-cover"`.
- Meta span: `min-w-0 flex-1`.
- Title span: `cn("block truncate text-sm font-medium", isActive && "text-emerald-500")` (active → emerald text).
- Artist span: `block truncate text-xs opacity-70`.
- Download button class (passed to `OfflineSongDownloadButton`): `wf-control-button text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10`.
- **Now-playing disc (only when `isActive`)**: `aria-hidden`, `pointer-events-none wf-control-button h-9 w-9 rounded-full bg-emerald-500 text-white grid place-items-center shrink-0`. Icon: `isActiveAndPlaying ? <Pause size={17} /> : <Play size={17} className="translate-x-[1px]" />` — **36×36 emerald disc, white icon**, shown only on the active row ("quiet rows stay clean").
- TrackActions class: `h-9 w-9 text-foreground/70 hover:bg-black/10 hover:dark:bg-white/10`.

### Props / store / interactions
Same prop set as SongCard minus `hideIfUnliked`. Same `handlePlay` logic, same `usePlayerStore`/`useOfflineStore`/`warmPlaybackSong`/`memo` comparator. Difference vs card: the green disc appears **only on the active row** (not on hover, no per-row floating disc for inactive rows).

### Hazards
Same as SongCard (hover variants, fill image, custom events, lucide).

---

## 6. `OfflineDownloadButton.tsx` — download affordance

Exports two components: `OfflineSongDownloadButton` (per-song) and `OfflineBulkDownloadButton` (scope-wide). **Crucially the affordance is NOT a lucide `Download` icon** — it's a `DownloadProgressPie` (conic-gradient ring) for in-flight, a `DownloadedBadge` SVG (emerald check disc) for done, plus lucide `CircleArrowDown` (idle), `RefreshCw` (failed/retry), `X` (cancel).

### `DownloadProgressPie({progress, size=18, className})`
A circular pie via CSS conic-gradient + inset ring + center dot.
```
<span aria-hidden class={cn("relative block rounded-full shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_52%,transparent)]", className)}
  style={{ width:size, height:size,
           background: `conic-gradient(currentColor ${round(clamp(progress,0,1)*360)}deg, color-mix(in srgb, currentColor 22%, transparent) 0deg)` }}>
  <span class="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current" />
</span>
```
- Filled arc = `currentColor` swept `progress*360deg`; track = `currentColor @ 22%`; 1px inset ring = `currentColor @ 52%`; center dot 6×6 `bg-current`.
- **PORT:** no `conic-gradient` / `color-mix` / inset box-shadow in RN. Rebuild as `react-native-svg` `<Circle>` with `strokeDasharray`/`strokeDashoffset` progress ring (circumference * (1-progress)), plus a small filled center dot. Drive color via prop, not `currentColor`.

### `DownloadedBadge({size=18})` — the "done" SVG (colors HARDCODED on purpose)
```
<svg width=size height=size viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <circle cx="12" cy="12" r="11" fill="#10b981" />
  <path d="M6.75 12.5l3.4 3.4 7.1-7.4" fill="none" stroke="#04140d"
        stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
</svg>
```
- **Emerald disc `#10b981` + dark check `#04140d`.** Comment says colors are hardcoded (not `currentColor`) deliberately so tailwind-merge from the caller's `text-foreground/70` can't gray it out. Keep hardcoded in RN.

### `OfflineSongDownloadButton({song, className})`
Returns `null` if `!canCacheSong(song)` (false for `browser-local`/`picked-file` source, blob/data audioUrl, or cross-origin audioUrl — uses `location.origin`).

State: `useOfflineStore` → `record = records[song.id]`, `queueDownloads`, `removeDownload`, `hydrate`. `status = getSongDownloadState(record)` ∈ idle/`queued`/`downloading`/`downloaded`/`failed`. `inFlight = queued||downloading`. `busy = actionPending||inFlight`. `progress = clamp(record.progress,0,1)`.

Button:
```
<button type="button" aria-label={title} title={title} onClick={handleClick} disabled={actionPending}
  class={cn(
    "group relative grid h-9 w-9 shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
    status==="downloaded" ? "text-emerald-500"
      : (status==="failed"||actionError) ? "text-red-300"
      : "text-white/[0.68] hover:bg-white/[0.09] hover:text-white",
    inFlight && "text-emerald-400 hover:text-white",
    actionPending && "cursor-wait",
    className)}>
```
Icon selection:
- `inFlight` → `<DownloadProgressPie progress className="text-emerald-400" />` + a hover-only `<X size={14}>` centered (`group-hover:block`/`group-focus-visible:block`, else `hidden`) → "tap to cancel".
- `actionPending` → `<DownloadProgressPie progress />`.
- `downloaded` → `<DownloadedBadge size={18} />`.
- `failed` → `<RefreshCw size={18} className="text-red-400" />`.
- else (idle) → `<CircleArrowDown size={18} />`.

`title`/aria text by state: downloaded→"Remove offline download"; actionError→the error; failed→"Retry offline download"; inFlight→`Downloading ${pct}% · tap to cancel`; idle→"Download for offline playback".

`handleClick` (stops propagation, `impactLight()`): downloaded→open confirm dialog; inFlight→`removeDownload(song.id)` (cancel); else→`queueDownloads([song], `song:${song.id}`)`.

**Confirm dialog** (when removing a downloaded song): rendered via `createPortal(..., document.body)`, full-screen `fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-sm`; panel `w-full max-w-sm rounded-2xl border border-white/15 bg-zinc-950 p-5 text-white shadow-[0_20px_80px_rgba(0,0,0,0.65)]`; heading "Remove download?"; body `This will delete the offline copy of "${song.title}" from this device.`; Cancel button (`rounded-full border border-white/20 ...`) + Remove button (`rounded-full bg-emerald-500 ... text-black`). Esc closes (unless pending), focus trap to cancel button, restores previous focus.

### `OfflineBulkDownloadButton({songs, scope, label="Download", className, iconOnly=false, hideWhenDownloaded=false})`
Header "download all" button (used by SongGrid). Status from both in-memory store (`getScopeDownloadState`) AND an authoritative debounced IDB read (`readScopeDownloadState`, 400ms debounce on store subscribe) — IDB wins (`status = idbStatus ?? inMemoryStatus`). `progress = scopeProgress(records, songs, scope)`.

Button class:
```
cn(
  iconOnly ? "grid h-11 w-11 place-items-center rounded-full"
           : "inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-medium",
  "shrink-0 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500",
  downloaded ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20"
    : actionError ? "bg-red-500/15 text-red-300 hover:bg-red-500/20"
    : "bg-white/[0.08] text-white/[0.78] hover:bg-white/[0.12] hover:text-white",
  inFlight && "text-emerald-300",
  actionPending && "cursor-wait",
  cacheableSongs.length===0 && "cursor-wait opacity-70",
  className)
```
Content: `busy ? <DownloadProgressPie progress size={iconOnly?24:17}/> : <Icon size={iconOnly?24:17}/>` then `{!iconOnly && <span>{text}</span>}`. `Icon = downloaded?X : failed?RefreshCw : inFlight?X : CircleArrowDown`. `text` by state: error→"Retry downloads"; downloaded→"Remove downloads"; failed→"Retry downloads"; inFlight→`Downloading ${pct}% · cancel`; partial→"Finish download"; else→`label`. Same confirm-dialog pattern ("Remove downloads?").

### Hazards (download buttons)
- `conic-gradient`, `color-mix(in srgb,...)`, inset `box-shadow` → not in RN; rebuild pie as SVG ring.
- `createPortal` + `document.body`, `document.activeElement`, `document.addEventListener("keydown")`, `window.requestAnimationFrame` → RN: use a `Modal` component; no portal/document.
- `backdrop-blur-sm` on dialog → `expo-blur` or solid overlay.
- IndexedDB (`useOfflineStore` reads/writes IDB; `readScopeDownloadState` is one txn/song) and the download pump → entire offline subsystem is web-only (Cache API / IDB / service worker). RN must rewrite using `expo-file-system` + a SQLite/AsyncStorage record store.
- `canCacheSong` uses `location.origin` + same-origin check on relative `/api` URLs.
- `impactLight()` → `expo-haptics`.
- lucide icons → `lucide-react-native`.

---

## 7. `CoverImage.tsx` — `<img>` with fallback chain + responsive srcSet

A drop-in `<img>` wrapper. Props: `src`, `networkSrc?` (remote retry), `fallbackSrc="/apple-icon.png"`, `fill?`, `priority?`, plus passthrough `ImgHTMLAttributes` (sizes, width, height, loading, className, style, srcSet…). Strips Next-isms (`quality`/`placeholder`/`blurDataURL`/`unoptimized`) — they're ignored.

### Behaviour
- Builds an ordered candidate list: `[src, networkSrc(if distinct), fallbackSrc(if distinct)]`. `sourceStage` indexes it; each `onError` advances `sourceStage` (clamped). Resets to 0 when `src`/`networkSrc`/`fallbackSrc` change.
- `resolvedSrc = normalizeCoverImageUrl(candidates[min(sourceStage, len-1)])`.
- Renders `<img src={resolvedSrc} loading={priority||eager?"eager":"lazy"} decoding="async" fetchPriority={priority?"high":undefined} width/height (omitted when fill) sizes srcSet={passed ?? generatedSrcSet} onLoad onError />`.
- `fill` → inline style `{position:"absolute", inset:0, width:"100%", height:"100%"}` merged with caller style.
- **Capacitor stall guard:** if `resolvedSrc` is a `_capacitor_file_` URL and hasn't loaded, a 4000ms timeout advances `sourceStage` (because missing capacitor scheme URLs never fire `onerror` in WKWebView).

### Responsive srcSet (web-only optimization)
- `artworkVariantUrl(src, width)`: only for `/api/files/...` (not `/api/files/local/`, not offline-param URLs), image extensions only → rewrites to `/api/artwork/r2/${encodedPath}?w=${width}`. Widths `[64,128,256,384,640]`.
- `COVER_IMAGE_WIDTHS = [64,128,256,384,640]`.

### Hazards
- Entire component is `<img>` + `srcSet`/`sizes`/`fetchPriority`/`decoding`/`loading` — **all web-only**. RN: use `expo-image` (`<Image source={{uri}} placeholder ... onError recyclingKey>`); it has built-in fallback/placeholder but you must reimplement the candidate-chain advance on `onError` manually (track stage in state, swap uri).
- `isCapacitorFileUrl` + capacitor scheme + 4000ms stall fallback → in RN offline images use `file://` from `expo-file-system`; keep a similar onError→networkSrc→fallback chain.
- `normalizeCoverImageUrl` + relative `/api/...` URLs → must prefix absolute base URL in RN.
- `srcSet`/`?w=` responsive variants → use `expo-image` with a single sized URL, or request the right `?w=` for the rendered size.

---

## 8. `SongGrid.tsx` — grid/list container + toggle + header + virtualization

### Props
`songs: PlayerSong[]`, `likedSongIds=[]`, `hideIfUnliked=false`, `canLike=false`, `showLikeControls=true`, `showQueueButton=true`, `bulkDownloadScope?: DownloadScope`, `emptyLabel?`, `viewToggleClassName?`. `showRowDownload = !bulkDownloadScope` (per-row download hidden when a bulk button is shown).

### State / store
- Local: `viewMode: "grid"|"list"` (default grid), `sortMode: "default"|"uploaded_desc"|"uploaded_asc"`, `preferencesReady`, virtual ranges.
- **`localStorage` persistence**: reads `spotify_song_view_mode` & `spotify_song_sort_mode` on mount; writes on change. **PORT:** AsyncStorage.
- `usePlayerStore`: `setQueue`, `currentSong`, `isPlaying`, `play`, `pause`, `shuffle`, `toggleShuffle`.
- `useLikesStore`: `mergeInitial`, `toggleLike`, `likedSongIds` lookup, `pending`, `hydrated`. `likedMap = hydrated ? likedLookup : initialLookup`.
- Derived: `sortedDedupedSongs` (sort by `createdAt` for non-default, dedup by id) → `visibleSongs` (filter to liked when `hideIfUnliked`).

### Header (verbatim)
Outer: `cn(!preferencesReady && "opacity-0")` wrapping `cn("mb-3 flex w-full items-center gap-2", viewToggleClassName)` → inner `ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:flex-none`.

Header controls in order:
1. **Play/Pause-all button** — `wf-control-button grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#1ed760] text-black shadow-[0_8px_18px_rgba(0,0,0,0.22)] transition hover:bg-[#1fdf64] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1ed760] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-[#1ed760]`. **This is the `#1ed760` green** (Spotify green, hover `#1fdf64`), black icon. Icon: `listIsPlaying ? <Pause size={20} fill="currentColor"/> : <Play size={20} fill="currentColor" className="translate-x-0.5"/>`.
2. **Shuffle button** — `cn("relative grid h-10 w-10 shrink-0 place-items-center rounded-full border border-black/10 bg-black/5 text-foreground/70 transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70 dark:border-white/10 dark:bg-white/5 dark:text-white/70 dark:hover:text-white", "wf-control-button", shuffle && "text-[#1ed760] dark:text-[#1ed760]")` with `<Shuffle size={19}/>` + an active dot `<span class={cn("absolute bottom-1 h-1 w-1 rounded-full bg-[#1ed760] transition-opacity", shuffle ? "opacity-100":"opacity-0")}/>`. Active state uses `#1ed760`.
3. **Bulk download** (if `bulkDownloadScope`): `<OfflineBulkDownloadButton iconOnly className="wf-control-button h-10 w-10" />`.
4. **Sort `<select>`** — `h-10 min-w-0 flex-1 rounded-lg border border-black/10 bg-black/5 px-3 text-sm dark:border-white/10 dark:bg-white/5 sm:w-64 sm:flex-none`. Options: "Sort: Default" / "Sort: Upload date (newest)" / "Sort: Upload date (oldest)". **PORT:** RN needs a custom picker / ActionSheet (no `<select>`).
5. **View toggle group** — wrapper `inline-flex h-10 shrink-0 items-center rounded-lg border border-black/10 bg-black/5 p-1 dark:border-white/10 dark:bg-white/5`. Two buttons, each `cn("inline-flex h-8 w-9 items-center justify-center gap-2 rounded-md text-sm transition sm:w-auto sm:px-3", "wf-control-button", viewMode===X && "bg-black/10 font-medium dark:bg-white/10")`:
   - Grid: `<LayoutGrid size={16}/>` + `<span class="hidden sm:inline">Grid</span>`, `aria-pressed`, `title="Grid view"`, `onClick={setNextViewMode("grid")}`.
   - List: `<Rows3 size={16}/>` + `<span class="hidden sm:inline">List</span>`, `title="List view"`, `onClick={setNextViewMode("list")}`.
   - **Icons: `LayoutGrid` (grid) and `Rows3` (list)** from lucide. Active segment highlighted with `bg-black/10 dark:bg-white/10 font-medium`. Labels hidden on mobile (`hidden sm:inline`).

### Body
- **Grid view** grid classes (both virtual & non-virtual inner): `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4`. Renders `<SongCard>` per song via `renderSongCard(song, index)` (passes `liked`, `likePending`, `canLike`, `showLike=showLikeControls`, `showQueue=showQueueButton`, `showDownload=showRowDownload`, `onToggleLike=handleToggleLike`, `hideIfUnliked`, `priority={index<6}`).
- **List view**: non-virtual wrapper `space-y-2` of `<SongListItem>`; virtual wrapper absolutely positions each row.
- **Virtualization** (web-only, custom): grid virtualizes at `≥80` items (`VIRTUALIZATION_MIN_ITEMS`), measuring columns/rowHeight from computed style + `ResizeObserver`, scrolling the `.wf-main` container. List virtualizes with fixed `VIRTUAL_ROW_HEIGHT=72`. Overscan 4 (grid) / 8 (list). **PORT:** discard entirely — RN uses `FlatList`/`FlashList` with `numColumns` for the grid; they virtualize natively.

### Interactions
- `onPlayAt(index)` → `setQueue(visibleSongsRef.current, index)`.
- `handlePlayVisibleSongs` (header play): if current song is in list → toggle pause/play; else `setQueue(songs, 0, {respectShuffle:true})` then `requestImmediatePlayback(startedSong)`.
- `handleToggleLike(songId, nextLiked)`: if `!canLike` → `navigate("/signin")`; else `toggleLike(...)`; on `401` → `/signin`.
- `listIsPlaying = currentSongIsInList && isPlaying` drives header play/pause icon.

### Empty state
If `visibleSongs.length === 0`: when `hideIfUnliked && emptyLabel` → `<div class="opacity-70">{emptyLabel}</div>`; else `null`.

### Hazards (SongGrid)
- `localStorage` (view/sort prefs) → AsyncStorage.
- All virtualization: `window.getComputedStyle`, `ResizeObserver`, `getBoundingClientRect`, `.closest(".wf-main")`, `window.scroll`/`resize` listeners, `requestAnimationFrame` → **delete; use FlatList/FlashList**.
- `grid-cols-* gap-4` responsive grid → FlatList `numColumns` (fixed; RN can't do responsive breakpoint columns without measuring width).
- `<select>` → custom picker.
- `hidden sm:inline` label visibility → RN: just always show or always hide.
- `navigate("/signin")` (react-router) → React Navigation.
- `requestImmediatePlayback` custom event + `warmPlaybackSong` web fetch.

---

## 9. PlayerSong shape (fields referenced by these components)
From usage: `id`, `title`, `artist`, `imageUrl`, `networkImageUrl`, `audioUrl`, `duration`, `createdAt`, `source` (`"browser-local"`/`"picked-file"`/etc.). Likes keyed by `song.id`. Offline `records[song.id]` = `{ pinnedBy: DownloadScope[], progress: number, status: "queued"|"downloading"|"downloaded"|"failed"|... }`.

## 10. Summary of green usage (quick reference for the implementer)
- `#1ed760` (literal): MobileNav is NOT green (white/`#b3b3b3`); SongGrid header **play-all** button bg, **shuffle active** text + dot, mini-player **liked-heart container** + **repeat-active** (desktop). Hover `#1fdf64`.
- `emerald-500` = `#10b981` / `rgb(16,185,129)`: SongCard floating play disc, SongListItem active-row play disc + active title + active row bg (`/10`) + card ring; mini-player top **progress fill** + liked Heart **icon fill**; download "downloaded" states; `DownloadedBadge` disc (`#10b981`) with `#04140d` check.
