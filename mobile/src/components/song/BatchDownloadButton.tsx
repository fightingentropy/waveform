import { useMemo } from "react";
import { ArrowDownCircle } from "lucide-react-native";
import { View } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { DownloadProgressRing } from "@/components/song/DownloadProgressRing";
import { colors } from "@/theme";
import { type DownloadScope, useBatchDownload, useOfflineStore } from "@/store/offline";
import { isDiscoverTrack } from "@/lib/player-song";
import type { PlayerSong } from "@/types/player";

// "Download all" affordance for a playlist / Liked Songs. Outline arrow when
// nothing's downloaded, a determinate fill ring (tap to cancel) while the batch
// streams in, and a filled arrow once every track is offline.
export function BatchDownloadButton({
  songs,
  scope,
  size = 30,
}: {
  songs: PlayerSong[];
  scope: DownloadScope;
  size?: number;
}) {
  // Discover tracks (Top 50 / YouTube Discover Mix) can't be downloaded directly —
  // they stream from the .discover staging cache and must be promoted into the
  // library first (see DownloadButton). Drop them so "Download all" never queues a
  // broken empty-URL / lossy-staging download; if the whole playlist is Discover,
  // render nothing.
  const downloadable = useMemo(() => songs.filter((song) => !isDiscoverTrack(song)), [songs]);
  const agg = useBatchDownload(downloadable, scope);
  const queueDownloads = useOfflineStore((s) => s.queueDownloads);
  const unpinScopeFromSongs = useOfflineStore((s) => s.unpinScopeFromSongs);

  const onPress = () => {
    if (agg.status === "downloading") {
      void unpinScopeFromSongs(
        downloadable.map((song) => song.id),
        scope,
      );
    } else if (agg.status !== "ready") {
      void queueDownloads(downloadable, scope);
    }
  };

  if (downloadable.length === 0) return null;

  return (
    <PressableScale
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={
        agg.status === "ready" ? "Downloaded" : agg.status === "downloading" ? "Cancel download" : "Download all"
      }
    >
      <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
        {agg.status === "downloading" ? (
          <DownloadProgressRing size={size} strokeWidth={2.5} progress={agg.progress}>
            <View
              style={{ width: size * 0.24, height: size * 0.24, borderRadius: 2, backgroundColor: colors.emerald }}
            />
          </DownloadProgressRing>
        ) : (
          <ArrowDownCircle
            size={size}
            color={agg.status === "ready" ? "#000" : colors.iconIdle}
            fill={agg.status === "ready" ? colors.emerald : "transparent"}
          />
        )}
      </View>
    </PressableScale>
  );
}
