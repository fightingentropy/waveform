import { memo, useCallback } from "react";
import { View } from "react-native";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { MarqueeText } from "@/components/ui/MarqueeText";
import { DownloadButton } from "@/components/song/DownloadButton";
import { TrackActionsButton } from "@/components/song/TrackActionsButton";
import { colors } from "@/theme";
import type { DownloadScope } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// Compact grid tile. Artwork carries the colour; controls and selection stay
// monochrome so repeated cards do not turn into a field of status badges.
function SongCardComponent({
  song,
  onPress,
  showDownload = true,
  showActions = true,
  downloadScope,
}: {
  song: PlayerSong;
  onPress: () => void;
  showDownload?: boolean;
  showActions?: boolean;
  downloadScope?: DownloadScope;
}) {
  // Keep one narrow player subscription per visible tile. Only the old/new
  // active rows re-render when playback moves through a large collection.
  const playbackState = usePlayerStore(
    useCallback(
      (s) => (s.currentSong?.id !== song.id ? "idle" : s.isPlaying ? "playing" : "paused"),
      [song.id],
    ),
  );
  const isActive = playbackState !== "idle";
  const isActiveAndPlaying = playbackState === "playing";

  return (
    <View
      className="relative w-full overflow-hidden"
      style={{ aspectRatio: 1, borderRadius: 10, borderCurve: "continuous", backgroundColor: colors.surface }}
    >
      <PressableScale
        scaleTo={0.985}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={isActiveAndPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
        className="absolute inset-0"
      >
        <CoverImage
          src={song.imageUrl}
          networkSrc={song.networkImageUrl}
          offlineSongId={song.id}
          style={{ width: "100%", height: "100%" }}
          recyclingKey={song.id}
        />
        <View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 64,
            backgroundColor: "rgba(0,0,0,0.76)",
          }}
        />
        <View className="absolute inset-x-2 bottom-2 flex-row items-end justify-between gap-2">
          <View className="min-w-0 flex-1">
            <MarqueeText className="text-[15px] font-medium text-white" active={isActive}>
              {song.title}
            </MarqueeText>
            <MarqueeText className="text-xs text-white/80" active={false}>
              {song.artist || "Unknown Artist"}
            </MarqueeText>
          </View>
          <View className="h-10 w-10 items-center justify-center">
            {isActiveAndPlaying ? (
              <Pause size={18} color="#fff" fill="#fff" strokeWidth={0} />
            ) : (
              <Play size={18} color="#fff" fill="#fff" strokeWidth={0} style={{ marginLeft: 1 }} />
            )}
          </View>
        </View>
      </PressableScale>
      {showDownload ? (
        <View className="absolute left-2 top-2 rounded-full bg-black/40 p-1.5">
          <DownloadButton song={song} scope={downloadScope} size={18} />
        </View>
      ) : null}
      {showActions ? (
        <View className="absolute right-2 top-2 rounded-full bg-black/40 p-1.5">
          <TrackActionsButton song={song} size={18} />
        </View>
      ) : null}
    </View>
  );
}

export const SongCard = memo(SongCardComponent);
