import { memo, useCallback } from "react";
import { View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { MarqueeText } from "@/components/ui/MarqueeText";
import { DownloadButton } from "@/components/song/DownloadButton";
import { TrackActionsButton } from "@/components/song/TrackActionsButton";
import { colors } from "@/theme";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// Grid card: square cover + floating emerald play button + title/artist over a
// bottom gradient. The grid SongCard/SongListItem use emerald (rgb 16,185,129),
// NOT the Home scroller's Spotify-green — see §4.
function SongCardComponent({
  song,
  onPress,
  showDownload = true,
  showActions = true,
}: {
  song: PlayerSong;
  onPress: () => void;
  showDownload?: boolean;
  showActions?: boolean;
}) {
  const isActive = usePlayerStore(useCallback((s) => s.currentSong?.id === song.id, [song.id]));
  const isActiveAndPlaying = usePlayerStore(useCallback((s) => s.currentSong?.id === song.id && s.isPlaying, [song.id]));

  return (
    <View
      className="relative w-full overflow-hidden rounded-card bg-card"
      style={{ aspectRatio: 1, borderWidth: isActive ? 2 : 0, borderColor: colors.emerald }}
    >
      <PressableScale
        scaleTo={0.985}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={isActiveAndPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
        className="absolute inset-0"
      >
        <CoverImage src={song.imageUrl} networkSrc={song.networkImageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={song.id} />
        <LinearGradient colors={["transparent", "rgba(0,0,0,0.6)"]} style={{ position: "absolute", left: 0, right: 0, bottom: 0, top: 0 }} />
        <View className="absolute inset-x-2 bottom-2 flex-row items-end justify-between gap-2">
          <View className="min-w-0 flex-1">
            <MarqueeText className="text-[15px] font-medium text-white" active={isActive}>
              {song.title}
            </MarqueeText>
            <MarqueeText className="text-xs text-white/80" active={false}>
              {song.artist || "Unknown Artist"}
            </MarqueeText>
          </View>
          <View className="h-10 w-10 items-center justify-center rounded-full" style={{ backgroundColor: colors.emerald }}>
            {isActiveAndPlaying ? (
              <Pause size={18} color="#fff" fill="#fff" />
            ) : (
              <Play size={18} color="#fff" fill="#fff" style={{ marginLeft: 1 }} />
            )}
          </View>
        </View>
      </PressableScale>
      {showDownload ? (
        <View className="absolute left-2 top-2 rounded-full bg-black/40 p-1.5">
          <DownloadButton song={song} size={18} />
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
