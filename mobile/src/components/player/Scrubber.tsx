import { useEffect, useState } from "react";
import { type AccessibilityActionEvent, type LayoutChangeEvent, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { seekTo } from "@/audio/actions";
import { useAudioProgress } from "@/audio/progress";
import { formatTime } from "@/lib/format";
import { usePlayerStore } from "@/store/player";
import { colors } from "@/theme";

const TRACK_H = 3; // thin track, Spotify-style
const THUMB = 12; // small flat thumb (no shadow), unlike the bulky native slider
const ROW_H = 48; // accessible touch target while preserving the thin visual track

// Spotify-style scrubber: a delicate 3px track with a small flat white thumb,
// elapsed on the left and REMAINING (negative) on the right. Custom (not the
// community Slider, whose native iOS thumb is bulky + shadowed). Reads the
// backend-agnostic progress store; while dragging we hold a local value so the
// thumb doesn't snap back. For radio there is no scrubber — a live dot shows.
export function Scrubber({ live = false }: { live?: boolean }) {
  const { position, duration } = useAudioProgress();
  const currentSongId = usePlayerStore((s) => s.currentSong?.id ?? null);
  const [width, setWidth] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);

  // Never carry the seek/hold state across a track change. The new track starts at
  // 0 (resetAudioProgress) and the scrubber must follow the live position, not a
  // stale seekValue — otherwise a seek on one song bleeds its position into the
  // next. Bulletproof backstop independent of any gesture-callback quirk.
  useEffect(() => {
    setSeeking(false);
  }, [currentSongId]);

  if (live) {
    return (
      <View className="flex-row items-center gap-2 py-2">
        <View className="h-2 w-2 rounded-full" style={{ backgroundColor: "#ef4444" }} />
        <Text style={{ color: colors.muted }} className="text-xs font-semibold uppercase tracking-wide">
          Live
        </Text>
      </View>
    );
  }

  const max = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const value = seeking ? seekValue : position;
  const pct = max > 0 && width > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const fillW = pct * width;
  const thumbLeft = Math.min(Math.max(0, fillW - THUMB / 2), Math.max(0, width - THUMB));

  const posFromX = (x: number) => (max <= 0 || width <= 0 ? 0 : Math.min(1, Math.max(0, x / width)) * max);

  // runOnJS(true) → callbacks run on the JS thread, so we can call setState/seekTo
  // directly (no reanimated worklets). `e.x` is the touch x within the track row.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    // Set the hold state on ACTIVATION (onStart), not onBegin. onBegin fires on
    // touch-down even for a tap — which the Tap gesture then wins via Race — and a
    // pan cancelled straight out of BEGAN need not fire onEnd, leaving `seeking`
    // stuck true so the scrubber freezes on `seekValue`. A pan that genuinely
    // activates always ends or cancels, so onEnd/onFinalize reliably clear it.
    .onStart((e) => {
      setSeeking(true);
      setSeekValue(posFromX(e.x));
    })
    .onUpdate((e) => setSeekValue(posFromX(e.x)))
    .onEnd((e) => {
      setSeeking(false);
      void seekTo(posFromX(e.x));
    })
    .onFinalize(() => setSeeking(false));
  // A tap seeks directly via the live position store; it never touches `seeking`,
  // so it can't leave the thumb held. (onStart above means the pan ignores taps.)
  const tap = Gesture.Tap()
    .runOnJS(true)
    .onEnd((e) => void seekTo(posFromX(e.x)));
  const gesture = Gesture.Race(tap, pan);

  return (
    <View className="w-full">
      <GestureDetector gesture={gesture}>
        <View
          style={{ height: ROW_H, justifyContent: "center" }}
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Playback position"
          accessibilityValue={{
            min: 0,
            max: Math.round(max),
            now: Math.round(value),
            text: `${formatTime(value)} of ${formatTime(max)}`,
          }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event: AccessibilityActionEvent) => {
            const delta = event.nativeEvent.actionName === "increment" ? 10 : -10;
            void seekTo(Math.min(max, Math.max(0, value + delta)));
          }}
        >
          {/* remaining (faint) track */}
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: (ROW_H - TRACK_H) / 2,
              height: TRACK_H,
              borderRadius: TRACK_H / 2,
              backgroundColor: "rgba(255,255,255,0.3)",
            }}
          />
          {/* elapsed (white) fill */}
          <View
            style={{
              position: "absolute",
              left: 0,
              top: (ROW_H - TRACK_H) / 2,
              height: TRACK_H,
              width: fillW,
              borderRadius: TRACK_H / 2,
              backgroundColor: "#fff",
            }}
          />
          {/* thumb */}
          <View
            style={{
              position: "absolute",
              top: (ROW_H - THUMB) / 2,
              left: thumbLeft,
              width: THUMB,
              height: THUMB,
              borderRadius: THUMB / 2,
              backgroundColor: "#fff",
            }}
          />
        </View>
      </GestureDetector>
      <View className="flex-row justify-between" style={{ marginTop: 6 }}>
        <Text style={{ color: colors.muted, fontVariant: ["tabular-nums"] }} className="text-xs">
          {formatTime(value)}
        </Text>
        <Text style={{ color: colors.muted, fontVariant: ["tabular-nums"] }} className="text-xs">
          {max > 0 ? `-${formatTime(Math.max(0, max - value))}` : formatTime(max)}
        </Text>
      </View>
    </View>
  );
}
