# PlayerBar Audio Engine — Port Notes (web → Expo / React Native)

Reconstruction-grade reference for the audio engine. Source files mapped:

- `src/components/PlayerBar.tsx` (2890 lines — the engine + bar UI)
- `src/lib/native-audio.ts` (Capacitor plugin bridge to native iOS AVPlayer)
- `src/lib/native-audio-element.ts` (`NativeAudioElement` — an `HTMLAudioElement` shim over an AVPlayer deck)
- `src/lib/crossfade-curve.ts` (equal-power fade math)
- `src/client/playback-warm.ts` (prefetch/warm)
- `src/client/play-events.ts` (play-event recording)
- `src/client/playback-state.ts` (cross-device resume state I/O)
- `src/lib/use-media-session.ts` (web lock-screen MediaSession)
- `src/lib/playback-position.ts` (4Hz scrubber event bridge)
- `src/client/podcast-progress.ts` (per-episode resume in localStorage)
- `src/lib/playback-gesture.ts` (user-gesture playback kick)
- `src/lib/playback-state.ts` (snapshot type + storage keys)

> **Architecture in one sentence:** PlayerBar owns **two** "decks" (audio elements A/B) so it can crossfade. On web/Android each deck is a hidden `<audio>` element; on **native iOS** each deck is a `NativeAudioElement` adapter that drives a native AVPlayer (so playback survives a locked screen). The store (`usePlayerStore`) holds queue/index/flags; **position/time is deliberately kept OUT of the store** (would churn at 4Hz) and lives in component refs + a window-event bridge.

---

## 0. Platform branches (the single most important thing to port)

There are effectively **three** audio runtime paths. The whole file is written so the same logic drives all three; in Expo you collapse them to ONE (`expo-av` / `react-native-track-player`).

| Path | Detector | Deck primitive | Fade mechanism | Survives lock screen |
|------|----------|----------------|----------------|----------------------|
| **Native iOS (Capacitor)** | `isNativeAudioPlatform()` = `Capacitor.isNativePlatform() && getPlatform()==="ios"` | `NativeAudioElement` → AVPlayer deck A/B | native `AudioEngine.crossfade()` ramp on the audio thread | yes |
| **iOS Safari / PWA (web, non-native)** | `isIosLikePlatform()` (UA `iP(hone\|od\|ad)`, or `Macintosh` + `maxTouchPoints>1`) | real `<audio>` routed through Web Audio `GainNode` | `linearRampToValueAtTime` on GainNode (equal-power) | only while playing (AudioContext suspends on lock) |
| **Desktop / Android** | else | real `<audio>` | `audio.volume` ramped on a `setInterval` (~60ms, equal-power) | n/a |

`webAudioModeRef`: `null` undecided / `true` use GainNodes (iOS web) / `false` use `audio.volume` (desktop/Android **and** native iOS, which clean-cuts via native ramp instead).

**Why the iOS gymnastics (read before porting):**
- `HTMLMediaElement.volume` is **read-only on iOS** (a write is silently ignored), so fades can't use `.volume`. iOS 26 made `.volume` *read back* the written value, so the runtime probe `audioVolumeIsWritable()` false-positives — hence `isIosLikePlatform()` forces the GainNode path regardless of the probe.
- A Web Audio `AudioContext` **suspends the instant the screen locks**, which silenced web playback. So the **native** path uses NO AudioContext — it plays straight into the AVAudioSession (`.playback` category + `UIBackgroundModes: audio`).
- `createMediaElementSource` is **permanent and once-per-element**; an element already "live" when you wire it bypasses its GainNode forever. So the graph is built **at mount, while both elements are idle** (effect at L738).

> **RN port:** none of this applies. `expo-av`/`react-native-track-player` give you a real volume API and OS-level background audio + lock-screen controls for free. Drop `AudioContext`, `GainNode`, `MediaElementSourceNode`, the `.volume`-writability probe, the `NativeAudioElement` shim, and the Capacitor plugin. Keep the *scheduling logic* (target/commit/forceCommit) and the *equal-power curve math*.

---

## 1. The two decks

```ts
const audioARef = useRef<HTMLAudioElement|null>(null);
const audioBRef = useRef<HTMLAudioElement|null>(null);
const [activeIdx, setActiveIdx] = useState<0|1>(0);
getActiveAudio()   = activeIdx===0 ? A : B
getInactiveAudio() = activeIdx===0 ? B : A
```

On native iOS the refs are eagerly populated with `new NativeAudioElement(deckForIndex(0|1))` (deck "A"/"B"). On web they are bound to two hidden `<audio hidden playsInline preload="auto">` JSX nodes (rendered at L2485 `renderAudio`).

**Crucial reconciliation rule (L2528):** the two `<audio>` nodes are rendered FIRST at a stable tree position in *both* the song and no-song states. If React reconciled them away on a null↔song transition it would destroy+recreate them → double playback + broken iOS user-gesture chain.

`audioSourceStateRef`: `WeakMap<HTMLAudioElement, AudioSourceState>` where
```ts
AudioSourceState = { src: string; hls: HlsInstance|null; nativeFallback?: boolean }
```
`src` is the resolved absolute URL currently assigned; `nativeFallback=true` means the element is playing the un-seekable `_capacitor_file_` scheme URL (blob read failed) — its positions must **never** be persisted as progress.

`webAudioNodesRef`: `WeakMap<HTMLAudioElement, {source: MediaElementAudioSourceNode; gain: GainNode}>`.

### `NativeAudioElement` (native-audio-element.ts) — the HTMLAudioElement slice it implements
Properties/methods PlayerBar relies on, mapped to AVPlayer calls:
- `src` setter → `AudioEngine.prepare({deck, url: toNativePlayableUrl(value), startAt: pendingStartAt})`. Setting `src` resets `readyState=HAVE_NOTHING`, `duration=0`. Empty string → `AudioEngine.stop`.
- `currentTime` getter (cached) / setter: if `readyState < HAVE_ENOUGH_DATA` it stores `pendingStartAt` (AVPlayer takes start-at as a prepare option, not a buffered write); else sets `_seeking=true`, `_seekTarget=value`, fires `AudioEngine.seek`, arms a **1500ms seek-safety timer** to clear `_seeking` if no `seeked` arrives.
- `duration` getter returns `NaN` before metadata (PlayerBar's `finiteMediaDuration` depends on that to fall back to catalog duration).
- `volume`/`muted` setters → `AudioEngine.setVolume({deck, volume: muted?0:v})`.
- `playbackRate` setter → `AudioEngine.setRate`.
- `play()` → `AudioEngine.play`, dispatches synthetic `play`. `pause()` → `AudioEngine.pause` + `pause` event. `load()` → re-`prepare`. `removeAttribute("src")` → clear + `AudioEngine.stop`.
- `addEventListener`/`removeEventListener`/`dispatch` — a tiny synthetic event system.
- `crossOrigin` accepted and ignored; `defaultPlaybackRate` accepted and ignored.

Native plugin events → synthetic DOM events (wired once globally in `wirePluginListeners`):
- `time(currentTime,duration)` → `timeupdate` (+ `durationchange` if duration changed). **Dropped while `_seeking`** to stop the scrubber flashing back to the pre-seek position.
- `loaded(duration)` → sets `readyState=HAVE_ENOUGH_DATA` then fires the full cluster `loadedmetadata, durationchange, loadeddata, canplay, canplaythrough`.
- `ended` → `ended`. `playing` → `playing` (bumps readyState). `waiting` → `waiting`.
- `seeked(time)` → ends the seeking window (only if `|time-_seekTarget|<0.75`, ignoring superseded mid-drag seeks), fires `seeked`.
- `error` → `error`.

`toNativePlayableUrl()` strips `capacitor://localhost/_capacitor_file_/…` back to the raw filesystem path (AVPlayer needs `fileURLWithPath:`); http(s) + m3u8 pass through.

---

## 2. Crossfade scheduling skeleton: `computeNextTarget` / `commit` / `forceCommit`

All three are **closures rebuilt inside one effect** (L1580) and exposed via refs so the audio element's `timeupdate`/`ended` handlers (which fire even when backgrounded) can call the latest versions:
```ts
maybeStartCrossfadeRef.current   = startCrossfade;
maybePrefetchCrossfadeRef.current = maybePrefetchCrossfade;  // native only
forceCommitCrossfadeRef.current  = forceCommit;
```
Effect deps: `activeIdx, advanceToIndex, crossfadeEnabled, crossfadeSeconds, currentIndex, currentSongIsPodcast, duration, ensureWebAudioGraph, getActiveAudio, getInactiveAudio, isPlaying, loadAudioSource, playFuture, queue, repeatMode, resolvePlaybackSong, setOutputLevel, shuffle, shuffleRemaining`.

### Crossfade state refs
- `crossfadingRef: boolean` — a fade is currently ramping.
- `crossfadeStartedRef: boolean` — per-effect latch so a fade arms only once; reset to false at effect-top **only if not currently crossfading**.
- `crossfadeCancelRef: (()=>void)|null` — the active fade's cancel closure (`cancelFade`/`cancelNative`); also used as the identity guard so a stale timer self-detaches.
- `crossfadeCommitSongIdRef: string|null` — set to the target song id at commit so the `currentSongId`-change effect (L1460) knows the change came from a commit and does NOT cancel the fade.
- `crossfadeTargetRef: {playbackSong, index, fromFuture}|null` — **THE captured target.** `forceCommit` must reuse this exact target, never recompute, because in shuffle mode `computeNextTarget()` draws a fresh random index → would commit a different song than the one already loaded+fading in.
- `suppressAutoLoadRef: boolean` — true during a fade so the "load current song into active element" effect doesn't yank the incoming source.
- `crossfadePrefetchRef` (native only): `{target, src}` of the deck pre-buffered ahead of the fade.

### `computeNextTarget()` → `{song, playbackSong, index, fromFuture} | null`
Mirrors `next()` exactly so the prefetched/faded track equals what a manual Next would play:
- **shuffle off:** `atEnd` (index ≥ len-1) → `repeatMode==="all"` ? index 0 : `null`; else index+1.
- **shuffle on:** if len===1 → null. Peek `playFuture` (redo stack) top; if it's a valid in-range index ≠ current, use it (`fromFuture=true`). Else `chooseNextShuffleIndex(len, current, shuffleRemaining)`. If not from future and `repeatMode!=="all"` and the shuffle pool minus current is exhausted → `null` (mirror next()'s stop-at-end).
- Returns `null` for empty queue or no next song. `playbackSong = resolvePlaybackSong(nextSong)` (offline resolution).

### `commit(incoming, target)` — shared finish
Fires when the fade timer elapses **or** via `forceCommit`:
1. `crossfadeCancelRef.current = null`.
2. `crossfadeCommitSongIdRef.current = target.playbackSong.id` (suppresses the cancel in the song-id-change effect).
3. `advanceToIndex(target.index, {fromFuture, preservePlayState: true})` — **preservePlayState** so a pause that landed mid-fade (lock screen) isn't overridden back to playing.
4. Swap active deck: `setActiveIdx(0↔1)`; native: `AudioEngine.setActiveDeck({deck})` so the native engine knows which deck drives time + Now Playing.
5. `setDuration(incoming.duration ?? target.playbackSong.duration ?? 0)`.
6. Clear `suppressAutoLoadRef`, `crossfadingRef`, `crossfadeStartedRef`, `crossfadeTargetRef`.

### `forceCommit()` — ended-before-ramp-finished (backgrounded/locked)
Fires from `handleEnded` when `crossfadingRef` is true (timer was throttled while backgrounded, but the audio-thread ramp already completed). Captures:
1. Guard: bail if `!crossfadingRef`.
2. `crossfadeCancelRef.current = null` (detach the running ramp timer — it self-clears).
3. `fromAudio=getActiveAudio()`, `incoming=getInactiveAudio()`.
4. **`target = crossfadeTargetRef.current ?? computeNextTarget()`** — reuse captured target; fresh pick only defensively (else queue wedges).
5. If no incoming/target: clear fade flags and return (let `onEnded` fallback run).
6. Pause+silence `fromAudio` (`setOutputLevel(fromAudio,0)`), `setOutputLevel(incoming, muted?0:volume)`, `incoming.play()` if playing, then `commit(incoming, target)`.

### `cancelActiveCrossfade()` (L904)
Clears `crossfadeCancelRef`, `suppressAutoLoadRef`, `crossfadingRef`, `crossfadeStartedRef`, `crossfadeTargetRef`, `crossfadePrefetchRef`, then calls the captured cancel closure. Called when: queue/song changes that aren't a commit, sleep-timer expiry (an in-flight ramp ignores `pause()`), explicit seek mid-fade, no current song, the playback-gesture handler.

### When the fade arms — `startCrossfade()`
Called from `handleTimeUpdate` every tick (after `maybePrefetchCrossfade`). Guards in order:
- `crossfadeEnabled` must be on; bail if already started/crossfading; bail if `!isPlaying` or `repeatMode==="one"`; bail if **podcast** (fade-window math assumes media-time==wall-time, wrong at rate≠1; also crossfading speech is undesirable).
- `total = fromAudio.duration ?? duration` (finite); `fadeWindow = min(crossfadeSeconds, max(0, total/2))`; bail if ≤0.
- `remaining = total - fromAudio.currentTime`; **arm only when `remaining <= fadeWindow + 0.05`**.
- Pick `target` (native: reuse `crossfadePrefetchRef.target`; else `computeNextTarget()`); bail if null.
- Set started/crossfading/suppressAutoLoad flags + `crossfadeTargetRef=target`.
- `loadAudioSource(incoming, target.playbackSong.audioUrl)`, `incoming.currentTime=0`.
- `fadeMs = fadeWindow*1000`, `targetVol = muted?0:volume`. Then branch into one of the three fade bodies (§3).

### Native prefetch — `maybePrefetchCrossfade()` (native only)
Buffers the next track onto the idle deck `NATIVE_CROSSFADE_PREFETCH_LEAD_S = 8`s before the fade window so its volume rises in sync rather than popping in late while AVPlayer is still loading. Same guards as start; arms when `remaining <= fadeWindow + 8`. Stores `crossfadePrefetchRef = {target, src}` and `loadAudioSource(incoming, …)` (play/pause sync keeps it paused). Dropped on any `currentSongId` change (L753).

---

## 3. The THREE fade bodies (exact web primitives)

### (A) Native AVPlayer ramp — `isNativeAudioPlatform()` true (L1723)
```ts
AudioEngine.crossfade({ from: deckForIndex(activeIdx), to: deckForIndex(other),
                        durationMs: fadeMs, peak: targetVol });
nativeTimeout = window.setTimeout(finishNative, fadeMs);  // JS-side commit timer
```
The native engine runs the **equal-power** ramp on the audio thread (from→0, to→peak), plays the incoming deck, and pauses the outgoing deck at the end. JS only schedules the queue-advance commit via `setTimeout`. `finishNative` guards `crossfadeCancelRef===cancelNative`, pauses incoming if not playing, then `commit`. `cancelNative` clears the timeout, pauses+silences incoming, restores `fromAudio` to `muted?0:volume` (this restore cancels the native ramp), resets fade flags. **Web primitives touched:** only `window.setTimeout`/`window.clearTimeout`. Everything audible is native.

### (B) Web-Audio GainNode ramp — iOS web, `webAudio===true` (L1803)
```ts
const ctx = audioContextRef.current;             // AudioContext
const fromNode = webAudioNodesRef.get(fromAudio);// {source, gain}
const toNode   = webAudioNodesRef.get(incoming);
const t0 = ctx.currentTime;
scheduleEqualPowerRamp(fromNode.gain.gain, t0, fadeWindow, targetVol, "out");
scheduleEqualPowerRamp(toNode.gain.gain,   t0, fadeWindow, targetVol, "in");
timeoutId = window.setTimeout(finish, fadeMs);   // throttled when backgrounded → ended drives forceCommit
```
`scheduleEqualPowerRamp` (crossfade-curve.ts) = `param.cancelScheduledValues(startTime)` + `param.setValueAtTime(...)` + 24× `param.linearRampToValueAtTime(...)` tracing a cos/sin curve. Piecewise-linear deliberately (not `setValueCurveAtTime`) because cancel/commit interrupts with `cancelScheduledValues`+`setValueAtTime`, which some browsers throw on inside an active value curve. `incoming.play()` is called with gain pre-set to 0. **Web primitives touched:** `AudioContext`, `GainNode.gain` (an `AudioParam`: `cancelScheduledValues`, `setValueAtTime`, `linearRampToValueAtTime`), `MediaElementAudioSourceNode`, `ctx.currentTime`, `window.setTimeout`. Ramp runs on the audio thread so it stays smooth when backgrounded; the JS commit timer may throttle, so the outgoing `ended` event drives `forceCommit`.

### (C) `audio.volume` setInterval ramp + clean-cut — desktop/Android, `webAudio===false` and `.volume` writable (L1821)
```ts
intervalId = window.setInterval(tick, 60);  // ~60ms; fires even when backgrounded (unlike rAF)
const tick = () => {
  const elapsed = min(fadeMs, performance.now() - startTs);
  const t = elapsed/fadeMs;
  fromVol = (muted?0:volume) * equalPowerGain(t,"out");
  toVol   = targetVol        * equalPowerGain(t,"in");
  if (fromAudio.currentTime >= fromStartTime) setOutputLevel(fromAudio, fromVol);
  setOutputLevel(incoming, toVol);
  if (elapsed >= fadeMs) finish();
};
```
`setOutputLevel` writes `audio.volume` here (no GainNode). `finish` pauses `fromAudio`, sets levels to final, `commit`. **Web primitives touched:** `window.setInterval`, `performance.now()`, `audio.volume`, `audio.currentTime`.

**Clean-cut fallback (L1765):** if `!webAudio && !audioVolumeIsWritable(fromAudio)` (iOS without a usable graph): `fromAudio.pause()` then immediate `commit(incoming, target)` — no overlap, so two tracks never blast at full volume simultaneously.

`equalPowerGain(progress, dir)` = `cos(p·π/2)` for "out", `sin(p·π/2)` for "in"; keeps `cos²+sin²=1` so the overlap doesn't dip ~3dB mid-fade.

`setOutputLevel(audio, level)` (L718): if the element has a GainNode → `gain.gain.cancelScheduledValues(now)` + `setValueAtTime(level, now)`; else `audio.volume = level`. One call site for both crossfade ramps and the ordinary volume slider.

> **RN port of crossfade:** keep `computeNextTarget`/`commit`/`forceCommit`/the captured-target rule and the equal-power curve. Replace all three bodies with a single timer (or library ramp) that sets `soundA.setVolumeAsync()` / `soundB.setVolumeAsync()` (expo-av) on a ~50ms interval following `equalPowerGain`. There's no read-only-volume problem in RN, so no GainNode/clean-cut branch needed.

---

## 4. Robustness layer

### 4.1 Error circuit-breaker — `handleActiveAudioError` (L2124)
Constants: `MAX_CONSECUTIVE_AUDIO_ERRORS = 3`. Refs: `consecutiveAudioErrorsRef`, `erroredSrcRetryRef`.
1. Ignore if not the active element. Skip entirely for radio / browser-local / offline (own handling). Streaming podcasts deliberately fall through (one dead episode mustn't wedge the queue).
2. `notePlaybackNetworkFailure()` (45s backoff for speculative warming).
3. `baseSrc = state.src ?? audio.currentSrc ?? audio.src`. If not HLS and not already retried this src: set `erroredSrcRetryRef=baseSrc`, re-assign **cache-busted** `${baseSrc}${?|&}__retry=${Date.now()}`, `audio.load()`, `play()` if playing, return. (Retry the same track ONCE.)
4. Otherwise `consecutiveAudioErrorsRef += 1`. If `>= 3`: reset counters, `console.error`, `pause()` — **stop** (don't loop a dead queue forever).
5. Else clear `erroredSrcRetryRef` and `next()` (**skip**).
- Counters/guard reset to 0/null on first successful `playing` event (`handleActiveAudioPlaying`, L2113) which also calls `notePlaybackNetworkSuccess()`.

### 4.2 Double-404 → wipe queue — `refreshCurrentSong` (L1420)
On song change for non-radio/podcast/offline/browser-local songs, refetches `GET /api/songs/{id}` (`cache:"no-store"`):
- `401`/`403` → auth lost → `clearStaleCurrentSong()` (removeLocalPlaybackState + setQueue([],0) + pause).
- `404` → counts consecutive 404s for the same id in `refreshNotFoundCountRef`; **only after 2** consecutive 404s → wipe (a single 404 can be a mid-deploy/proxy hiccup).
- ok → `replaceSong(song)` (refresh metadata/URL), reset 404 count.

### 4.3 Captured-target forceCommit on ended — `handleEnded` (L2374)
If `crossfadingRef` true → `forceCommitCrossfadeRef.current()` and return (don't run normal end logic). Otherwise: podcast → `markEpisodeFinished`. `repeat one` (or `repeat all` with ≤1 song): flush+rearm the play-listen, honor end-of-track sleep, else `currentTime=0` + replay. Else `next()`.

### 4.4 Seek-in-flight suppression
- **Web pending-seek debounce** (`onSeek`, L1154): a user drag sets `pendingSeekRef` + optimistic scrubber, then a **90ms** `setTimeout` issues the real `performSeek`. In `handleTimeUpdate` (L2312): **if `pendingSeekRef` is set, ignore the tick entirely** (the element reports the OLD position until the seek is issued — would flash the scrubber back).
- **Sticky seek** (`stickySeekRef`, `STICKY_SEEK_RETRY_MS = 180`, `MAX_STICKY_SEEK_ATTEMPTS = 30`): when `audio.currentTime = x` doesn't land within `SEEK_LANDING_TOLERANCE_SECONDS = 0.75` (metadata not ready / non-seekable source), it re-attempts on a 180ms schedule up to 30 times, holding the optimistic time on the scrubber meanwhile. `resumeAfterSeekRef` remembers whether to resume after the seek lands.
- **Native seek-in-flight** (inside `NativeAudioElement`): `_seeking` flag drops `time` events until the matching `seeked` (or 1500ms safety timeout); `handleSeeked` ignores superseded mid-drag completions (`|time-target| >= 0.75`).

### 4.5 Audio-session interruption / background resume
- **Native:** `AudioEngine.configure()` once at mount (activates `.playback` AVAudioSession, creates decks, registers remote commands). On the user's play gesture, `AudioEngine.activateSession()` re-asserts the session so it survives a later lock.
- **Web (iOS) AudioContext resume:** an in-flight context is resumed on `visibilitychange`→visible (L1891). Also, `playAudio` (L959) **awaits `ctx.resume()` before `audio.play()`** when suspended, because an element that starts while the context is suspended outputs straight to the speakers, bypassing its GainNode (un-fadeable). `handleTogglePlayback` and the playback-gesture handler also call `ensureWebAudioGraph()` inside the gesture (only time iOS allows starting an AudioContext).
- There is **no explicit web "interruption" listener** (phone call etc.); the OS pauses the element and `play()` failures bubble up. RN must wire `expo-av`'s `InterruptionMode*` + `react-native-track-player`'s remote/duck events for auto-pause/resume.

### 4.6 Lock-screen artwork must be a remote http(s) URL
- **Native** (`nativeArtworkUrl`, L241): prefers `song.networkImageUrl || song.imageUrl`; returns `undefined` for `blob:`/`data:`/`capacitor:`/`_capacitor_file_` (the native `URLSession` can't fetch device-local covers). Resolves relative paths against `location.origin`. Pushed via `AudioEngine.setNowPlaying`.
- **Web** (`resolveArtworkUrl`, use-media-session.ts): falls back to `/icon-512.png` for empty/`blob:`/`data:`/`.svg`; passes http(s) through; resolves relative against origin. `MediaMetadata.artwork` = small `/apple-icon.png` (180×180) + large (512×512).

---

## 5. Prefetch / warm (`playback-warm.ts`)
Constants: `PLAYBACK_WARM_BYTES = 512KiB`, timeout 4s, dedupe 2min, queue limit 12, forward tracks 3, network backoff 45s. Cache name `spotify-playback-v1`.
- `prefetchUpcomingPlayback(queue, currentIndex, state)` — runs in an effect on queue/index/shuffle changes (L1234). Uses `getUpcomingPlaybackIndices(len, idx, 3, {shuffle, repeatMode, playFuture, shuffleRemaining})` so shuffle warms the songs that'll actually play. For each upcoming audio URL: warm a **`Range: bytes=0-524287`** request with `cache:"force-cache"`, `credentials:"include"`, then `response.body.cancel()`; sidecars (image/lyrics) go into the Cache API (`caches.open`). Dedupe via `warmPlaybackSeen` map; un-mark on failure.
- `warmPlaybackSong(song, priority)` — single-URL warm with FIFO queue (`pumpWarmPlaybackQueue`).
- Skips speculative fetch when offline, saveData, slow-2g/2g, or within the 45s `notePlaybackNetworkFailure` backoff.
- **Only same-origin, non-blob/data, non-offline, non-browser-local URLs are warmed.**

> **PORTING HAZARD:** uses `caches` (Cache API / Service Worker), `fetch` with relative→origin resolution, and `Range` requests. None exist in RN. Replace with `react-native-track-player` buffering, or a manual `expo-file-system` pre-download of the next track's URL. The Cache API sidecar warming has no RN equivalent — drop it (let the `<Image>` cache handle covers).

---

## 6. Resume-seek injection on load
Refs: `savedSeekRef = {songId, time}|null`, `lockedPlaybackSourceRef`, `lastResumeSeededSongIdRef`.
- The **load effect** (L1494) sets `savedSeekRef` for podcasts from `readEpisodeProgress` (once per song id, only if no snapshot seek already pending and not finished and `time >= PODCAST_RESUME_MIN_SECONDS = 10`). If the gesture pre-loaded the source and metadata is already present (`readyState >= HAVE_METADATA`), it applies the seek **immediately** (because `loadedmetadata` won't fire again).
- `handleLoadedMetadata` (L2289) → `applyPendingResumeSeek` (clamp `savedSeekRef.time` to duration via `performSeek`, consume the target only once the element actually moved — radio never holds a target) → `applyStoredPodcastResume` (last-resort: if element sits at <1s and stored progress ≥10s and not finished, seek there — this is what survives the native fallback→blob source swap) → retry sticky seek → restore output level → re-apply playbackRate.
- An explicit user seek (`onSeek`) clears `savedSeekRef` (a queued restore must not yank playback away from where the user scrubbed).
- A pending resume that hasn't landed **blocks** progress/snapshot writes (so a dropped seek can't overwrite the saved position): see `buildPlaybackStateSnapshot` (L459), `flushPodcastProgress` (L2017), and the timeupdate progress branch (L2349). Consumed in `handleTimeUpdate` once `nextTime` reaches/passes the target.
- **Native resume:** `NativeAudioElement.currentTime` setter stores `pendingStartAt` pre-metadata, which becomes `AudioEngine.prepare({startAt})`.

---

## 7. Sleep timer expiry — `enforceSleepTimerExpiry` (L917)
Store fields: `sleepTimerEndsAt: number|null`, `sleepAtEndOfTrack: boolean`. UI options `[5,15,30,45,60]` minutes.
- Reads the store fresh. If `endsAt==null || now < endsAt` → no-op.
- If the deadline already passed **before** the last resume (`endsAt <= lastResumeAtRef.current`) → just `cancelSleepTimer()` (don't instantly pause a manual resume).
- Else **`cancelActiveCrossfade()` first** (an in-flight ramp ignores `pause()` and its commit force-resumes), then `pause()` + `cancelSleepTimer()`. Canonical pause is the store's, never the elements directly.
- **Three drivers:** `handleTimeUpdate` (fires while backgrounded on iOS), the **8s `setInterval`** backstop (L1995, for stalled/backgrounded audio where timeupdate doesn't fire), and a 30s UI-only re-render tick for the label.
- **End-of-track sleep:** a `currentSongId` change while `sleepAtEndOfTrack` armed → pause+cancel (L1483). For an in-place repeat (same id, no change event) the same is enforced inside `handleEnded`.

---

## 8. Podcast progress (write ~5s, resume ≥10s)
Constants: `PODCAST_PROGRESS_WRITE_INTERVAL_MS = 5000`, `PODCAST_RESUME_MIN_SECONDS = 10`. Storage key `spotify_podcast_progress` (localStorage), max 200 entries (LRU by `updatedAt`).
- **Write (~5s):** in `handleTimeUpdate` (L2349), only for podcasts with no pending resume seek and not a `nativeFallback` source, throttled to ≥5s via `lastPodcastProgressWriteRef`, calling `writeEpisodeProgressGuarded(id, time, duration)`.
- `writeEpisodeProgressGuarded` (L2009): if `time < 10`, refuses to overwrite an existing progress that's ≥10s and not finished (a near-zero position is almost always a torn-down element, not a real listen).
- **Resume (≥10s):** seeded in the load effect / applied in `applyStoredPodcastResume`; only resumes when stored `time >= 10` and `!isEpisodeFinished`.
- `isEpisodeFinished`: within `PODCAST_FINISHED_TAIL_SECONDS = 30` of the end (or ≥95% for episodes ≤60s).
- `markEpisodeFinished` on natural `ended`; `flushPodcastProgress` on pagehide/visibility-hidden.

> **PORTING NOTE:** podcast progress + playback state + device id are **localStorage** (`spotify_podcast_progress`, `spotify_player_state`, `spotify_playback_device_id`, `spotify_player_state_pending_sync`). Use `@react-native-async-storage/async-storage` or `expo-secure-store`. All reads/writes are guarded with `typeof window === "undefined"` checks that you replace with the AsyncStorage API.

---

## 9. Play-events recording (30s OR ≥50%) — `play-events.ts`
- `PLAY_EVENT_MIN_POSITION_SECONDS = 30`. `shouldRecordPlay(maxPos, duration)` → true if `maxPos >= 30` **OR** (`duration > 0` and `maxPos >= 0.5*duration`).
- A `PlayListenEntry` (`{song, startedAtMs, maxPositionSeconds, durationSeconds, recorded}`) is tracked per song; `maxPositionSeconds` updated each `timeupdate`.
- **`flushPlayListen` fires at the song-change boundary** (effect L2062) — where every advance path converges (next/previous/advanceToIndex/crossfade-commit/error-skip/queue-empty). The `ended` event is NOT used: under crossfade the outgoing element is paused/unloaded at commit so `ended` never fires. Also flushed+rearmed on in-place repeat, and on pagehide (`keepEntry=true`).
- `recordPlayEvent` → `POST /api/play-events` `{song, durationMs}`, `credentials:"include"`, `keepalive:true`, `cache:"no-store"`, fire-and-forget. Skips browser-local/picked-file/radio; swaps offline-resolved songs for their canonical pre-resolution record (offline URLs would poison Home rails).

> **HAZARD:** comment explicitly says **`navigator.sendBeacon` is NOT patched by CapacitorHttp — never use it; use `fetch` with `keepalive`.** In RN there is no `keepalive` semantics and no relative-URL patching; rewrite as an absolute-URL `fetch` and accept it may be dropped on hard kill (or persist a pending-event queue).

---

## 10. Playback-state publish points (cross-device resume) — `playback-state.ts`
`PlaybackStateSnapshot = {version:1, accountScope, queue, currentIndex, song, currentTime, isPlaying, updatedAt, deviceId}`. Storage key `spotify_player_state`.
- **Routes:** `GET /api/playback-state` (returns `{state}`; 401/404→null), `PUT /api/playback-state` body `{state}` (returns server's accepted `{state}`; 401/404→null). `credentials:"include"`, `cache:"no-store"`.
- `buildPlaybackStateSnapshot(updatedAt)` (L459): filters queue to persistable songs, sanitizes (strips device-local URLs), uses pending-resume time if a seek hasn't landed, else element `currentTime` (only if `readyState >= HAVE_METADATA`) else `currentTimeRef`.
- **Publish triggers:**
  - `schedulePlaybackStateSync(delayMs)` debounced — on index/song/isPlaying/queue change (`1000ms` playing / `700ms` paused, L1985), on currentTime change while paused (`900ms`, L1990), and every **8s** while playing (L1995, `delay 0`).
  - `publishPlaybackState` dedupes via `playbackStateSyncSignature` (queue ids + scope + index + floor(time) + isPlaying + audioUrl); writes local first, then server; on offline/failure marks `…_pending_sync` and flushes on the `online` event.
  - On pagehide/beforeunload/visibility-hidden (L2069): flush pending sync with `keepalive:true`, else `saveCurrentPlaybackStateToLocal()`.
- **Restore** (L1338): on mount after auth settles, read local (scoped to `accountScope`), apply it, then fetch server; tie-break **server ≥ local wins**; otherwise push local up. `playbackSyncReadyRef` gates all publishes until restore completes (set true even on the cancelled/StrictMode-double-mount path, or every publish silently blocks).
- `getPlaybackDeviceId()` → persisted `crypto.randomUUID()` in localStorage.

---

## 11. Position bridge & MediaSession
- **`playback-position.ts`:** PlayerBar publishes a **4Hz** `{currentTime, duration}` via `window.dispatchEvent(CustomEvent("wf-playback-position"))`; leaf components `PlaybackScrubber` and `PlaybackProgressFill` subscribe so the scrubber stays smooth **without re-rendering all of PlayerBar**. React `currentTime` *state* is written only ~1Hz unless the full-screen sheet is open (`nowPlayingOpen`). Also `wf-playback-seek-request` lets satellite UIs (sidebar lyrics) request a seek.
- **`use-media-session.ts`** (web only; `enabled:false` on native iOS — the AVPlayer engine owns `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`): writes `navigator.mediaSession.metadata` / `playbackState` / `setPositionState` (throttled ~1Hz, but immediate on duration/rate change so the lock-screen scrubber rescales for VBR/HLS), registers `play/pause/previoustrack/nexttrack/seekto` handlers, refreshes on `visibilitychange`/`pageshow`.
- **Native lock-screen transport** (L2434): `AudioEngine.addListener("remote", …)` maps `play/pause/toggle/next/prev/seek` to store actions. `setNowPlaying` on track change, `updateNowPlaying({position,rate,playing})` on state change.

> **PORTING NOTE:** the entire `playback-position` CustomEvent bridge is a web-only optimization to dodge 4Hz Zustand churn. In RN you can either keep an event-emitter equivalent (`mitt`/`DeviceEventEmitter`) or use a separate lightweight store slice / `useRef`+`forceUpdate` throttle. MediaSession + the Capacitor remote listener both collapse into `react-native-track-player`'s `Event.Remote*` capabilities + `updateNowPlayingMetadata`.

---

## 12. Source loading & resolution
- `resolvePlayableSrc(src)` (L56): blob/data/file/capacitor/http pass through; else `resolveNativeApiUrl` (rewrites `/api/...` to `NATIVE_API_ORIGIN = https://music.streamarena.xyz` on native); else `${location.origin}${src}`.
- `loadAudioSource` (L835): native → set `audio.src` directly (AVPlayer handles http/HLS/file). Web HLS (`.m3u8`, not natively playable) → lazy-import `hls.js/light`, attach. Capacitor file → `attachNativeOfflineAudioSource` (acquire blob: URL; on failure fall back to the un-seekable scheme URL with a `[2.5s, 8s, 20s]` retry schedule that upgrades the element in place). Else set `crossOrigin` (`use-credentials` for our authed origins `NATIVE_API_ORIGIN` + `spotify.erlinhoxha.workers.dev`, `anonymous` for third-party radio, `null` same-origin) then `audio.src`.
- `CREDENTIALED_AUDIO_ORIGINS` = our authed audio endpoints that need the session cookie when routed through Web Audio.

> **PORTING HAZARDS in §12:** `hls.js`, `crossOrigin`/credentialed-CORS, `blob:` object URLs (`acquire/releaseNativeOfflineAudioObjectUrl`), `caches`, the `_capacitor_file_` scheme, and `location.origin`-relative resolution all break in RN. `expo-av`/`react-native-track-player` play HLS m3u8 + http(s) + local file paths natively (no hls.js, no blob upgrade). Offline files use a plain `file://` path from `expo-file-system`. Auth becomes a signed URL or a header on the source request (no cookie-credentialed media element).

---

## TOP PORTING RISKS (this area)

1. **The entire iOS audio plumbing is unportable and unnecessary in RN.** AudioContext/GainNode/MediaElementSourceNode, the read-only-`.volume` probe, `NativeAudioElement` AVPlayer shim, the Capacitor `AudioEngine` plugin, the lock-screen/background-audio dance, and the clean-cut fallback all exist to work around browser+WKWebView limits. `expo-av` or `react-native-track-player` give real volume control, background audio, and lock-screen controls natively — so reimplement crossfade as a single `setVolumeAsync` ramp on two `Sound` instances using the equal-power curve, and delete the three-path branching. **Keep** `computeNextTarget`/`commit`/`forceCommit`, the captured-target rule, and `equalPowerGain`.

2. **Pervasive web-only persistence & networking primitives.** `localStorage` (4 keys), the Cache API (`caches`, `spotify-playback-v1`), `Range`-request warming, `crossOrigin`/credentialed CORS, `blob:` URLs, the `_capacitor_file_` scheme, `navigator.serviceWorker` media caching, `fetch` with relative `/api/...` URLs (works on web + via CapacitorHttp patch, NOT in RN), and `keepalive`. Every one must be rewritten: AsyncStorage, `expo-file-system` pre-download, absolute API base URL, signed-URL or header auth, and a persisted pending-event/pending-sync queue for the lost `keepalive`/`beforeunload` reliability.

3. **Position/time is intentionally kept out of the store via a 4Hz `window` CustomEvent bridge** (`playback-position.ts`) to avoid Zustand re-render churn; React state is throttled to ~1Hz. Naively moving `currentTime` into the Zustand store in RN will re-render the player tree 4× a second. Preserve the throttle: use `DeviceEventEmitter`/`mitt` or a dedicated ref-based subscription, and keep the ~1Hz-vs-sheet-open distinction. Also note the load-bearing **seek-suppression** invariants (90ms pending-seek debounce ignoring pre-seek ticks, the sticky-seek 180ms×30 retry, the native `_seeking` window) and the **resume-seek/progress-blocking** invariant (a never-landed seek must block progress + snapshot writes) — these are subtle and must be carried over verbatim or resume/scrubbing will corrupt saved positions.
