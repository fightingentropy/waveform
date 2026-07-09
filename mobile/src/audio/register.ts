import { Platform } from "react-native";

// Registered at module load (imported first thing in app/_layout). On iOS the app
// uses the native dual-deck AudioEngine module (which owns its own lock-screen
// remote commands), so RNTP is not set up there and its playback service must NOT
// be registered. On Android/other, register the RNTP service before setupPlayer so
// remote commands route while the UI is backgrounded.
if (Platform.OS !== "ios") {
  // Conditional loading is intentional: importing RNTP eagerly on iOS would
  // initialize a second playback engine and register duplicate remote commands.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TrackPlayer = require("react-native-track-player").default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PlaybackService } = require("@/audio/service");
  TrackPlayer.registerPlaybackService(() => PlaybackService);
}
