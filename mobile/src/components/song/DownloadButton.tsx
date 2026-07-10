import { CheckCircle2, CircleArrowDown, RefreshCw } from "lucide-react-native";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { DownloadProgressRing } from "@/components/song/DownloadProgressRing";
import { colors } from "@/theme";
import { isDiscoverTrack, isRadioSong } from "@/lib/player-song";
import { type DownloadScope, getOfflineAccountScope, keyFor, useOfflineStore } from "@/store/offline";
import type { PlayerSong } from "@/types/player";

// Per-song download affordance. Idle = CircleArrowDown; queued = indeterminate
// ring (waiting in the serial pump); downloading = determinate fill ring with a
// centre stop square (tap cancels); ready = filled emerald check; error =
// RefreshCw (tap retries). Deliberately NOT lucide `Download` (that glyph is
// only the Library "Downloads" row).
export function DownloadButton({
  song,
  scope,
  size = 20,
  style,
}: {
  song: PlayerSong;
  scope?: DownloadScope;
  size?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const key = keyFor(getOfflineAccountScope(), song.id);
  const record = useOfflineStore((s) => s.records[key]);
  const progress = useOfflineStore((s) => s.progress[key]);
  const queueDownloads = useOfflineStore((s) => s.queueDownloads);
  const unpinScope = useOfflineStore((s) => s.unpinScope);
  // Radio is live; a Discover track must be promoted into the library before it can
  // be downloaded (a placeholder has no audioUrl; a staged copy is lossy/transient).
  if (isRadioSong(song) || isDiscoverTrack(song)) return null;

  const songScope: DownloadScope = scope ?? `song:${song.id}`;
  // Playback-ahead cache entries are intentionally invisible here. Tapping the
  // idle icon simply pins that already-cached file under the user's scope.
  const status = record?.scopes.includes(songScope) ? record.status : undefined;
  const active = status === "downloading" || status === "queued";

  const onPress = () => {
    // ready / in-flight → unpin (remove or cancel); idle / error → (re)queue.
    if (status === "ready" || active) void unpinScope(song.id, songScope);
    else void queueDownloads([song], songScope);
  };

  // Emerald stop square inside the ring → reads as "downloading, tap to cancel".
  const stopSquare = (
    <View
      style={{
        width: Math.round(size * 0.26),
        height: Math.round(size * 0.26),
        borderRadius: 1.5,
        backgroundColor: colors.emerald,
      }}
    />
  );

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={active ? "Cancel download" : status === "ready" ? "Remove download" : "Download"}
      hitSlop={8}
      onPress={onPress}
      style={style}
    >
      <View style={{ width: size + 4, height: size + 4, alignItems: "center", justifyContent: "center" }}>
        {status === "downloading" ? (
          <DownloadProgressRing size={size} progress={progress ?? 0}>
            {stopSquare}
          </DownloadProgressRing>
        ) : status === "queued" ? (
          <DownloadProgressRing size={size}>{stopSquare}</DownloadProgressRing>
        ) : status === "ready" ? (
          // dark check inside the filled emerald badge (emeraldDarkCheck)
          <CheckCircle2 size={size} color={colors.emeraldDarkCheck} fill={colors.emerald} />
        ) : status === "error" ? (
          <RefreshCw size={size} color={colors.muted} />
        ) : (
          <CircleArrowDown size={size} color={colors.iconIdle} />
        )}
      </View>
    </PressableScale>
  );
}
