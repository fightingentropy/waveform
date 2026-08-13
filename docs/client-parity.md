# Client parity contract

The browser and Expo clients share the same authenticated account, library,
playlist, playback-history, import, and discovery APIs. They must both expose:

- Home, search, library, liked songs, radio, podcasts, events, and playlists.
- Upload/import, settings, profile, and weekly listening statistics.
- Like, queue, play, seek, shuffle/repeat, playlist, and account workflows.

`src/lib/client-parity.ts` is the machine-readable route contract and
`tests/client-parity.test.ts` prevents one client from silently dropping a
shared workflow. API response types remain strict in each client and are checked
by the independent web and mobile TypeScript gates.

Some capabilities are deliberately platform-specific rather than parity bugs:

- Native offline downloads, durable background download/import queues, and
  device storage controls live only in Expo. The browser service worker and PWA
  download surface were intentionally removed.
- Dual-deck AVPlayer crossfade is iOS-only. Android plays through Track Player.
  Background downloads use URLSession on iOS and WorkManager on Android.
- The browser keeps desktop multi-column chrome, keyboard navigation, and hover
  interactions that do not apply to native screens.
- Native may add RSS feeds to its device-local podcast list. The browser uses
  the server-curated podcast list.

Any new shared workflow should update the route contract, both clients, and the
parity test in the same change. A platform-only feature should be recorded in
this document so an intentional difference is not mistaken for drift.
