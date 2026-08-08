import { memo, useCallback } from "react";
import { View } from "react-native";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Text } from "react-native";
import { DownloadButton } from "@/components/song/DownloadButton";
import { TrackActionsButton } from "@/components/song/TrackActionsButton";
import { colors } from "@/theme";
import type { DownloadScope } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";

// List rows stay visually flat. Active playback is communicated with a neutral
// transport glyph and a barely raised row, leaving artwork as the only colour.
function SongListItemComponent({
  song,
  onPress,
  showDownload = true,
  showActions = true,
  playlist,
  downloadScope,
}: {
  song: PlayerSong;
  onPress: () => void;
  showDownload?: boolean;
  showActions?: boolean;
  // The editable playlist this row belongs to (enables "Remove from this playlist").
  playlist?: { id: string; name: string };
  // Collection pin used by Download all, so this row reflects/cancels the same
  // queued record instead of creating an unrelated song:<id> pin.
  downloadScope?: DownloadScope;
}) {
  // One selector per visible row instead of two subscriptions evaluating the
  // same song-id comparison on every player-store update.
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
      className="flex-row items-center gap-3 px-4 py-2"
      style={isActive ? { backgroundColor: colors.card } : undefined}
    >
      <PressableScale scaleTo={1} onPress={onPress} className="min-w-0 flex-1 flex-row items-center gap-3">
        <View style={{ width: 48, height: 48, overflow: "hidden", borderRadius: 8, borderCurve: "continuous" }}>
          <CoverImage
            src={song.imageUrl}
            networkSrc={song.networkImageUrl}
            offlineSongId={song.id}
            style={{ width: "100%", height: "100%" }}
            recyclingKey={song.id}
          />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className="text-[15px]"
            style={{ color: colors.foreground, fontWeight: isActive ? "600" : "500" }}
          >
            {song.title}
          </Text>
          <Text numberOfLines={1} className="text-xs" style={{ color: colors.muted }}>
            {song.artist || "Unknown Artist"}
          </Text>
        </View>
      </PressableScale>

      {showDownload ? <DownloadButton song={song} scope={downloadScope} size={20} /> : null}

      {isActive ? (
        <View className="h-9 w-9 items-center justify-center">
          {isActiveAndPlaying ? (
            <Pause size={17} color={colors.foreground} fill={colors.foreground} strokeWidth={0} />
          ) : (
            <Play size={17} color={colors.foreground} fill={colors.foreground} strokeWidth={0} style={{ marginLeft: 1 }} />
          )}
        </View>
      ) : null}

      {showActions ? <TrackActionsButton song={song} size={20} playlist={playlist} /> : null}
    </View>
  );
}

export const SongListItem = memo(SongListItemComponent);
