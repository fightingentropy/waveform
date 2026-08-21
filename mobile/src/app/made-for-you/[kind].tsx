import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { MadeForYouCover } from "@/components/playlist/MadeForYouCover";
import { PlaylistDetailScreen } from "@/app/playlist/[id]";
import {
  type PlaylistPayload,
  type SearchIndexPayload,
  type StatsHomePayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  buildMadeForYouSongs,
  dailyMixSeeds,
  isMadeForYouKind,
  madeForYouDefinition,
  madeForYouRotationKey,
} from "@/lib/made-for-you";
import { fetchRecommendations, recommendationToPlayerSong } from "@/lib/smart-shuffle";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { PLAYBACK_CACHE_SCOPE, useOfflineStore } from "@/store/offline";
import { useLikesStore } from "@/store/likes";
import type { PlayerSong } from "@/types/player";

export default function MadeForYouPlaylistScreen() {
  const params = useLocalSearchParams<{ kind?: string | string[] }>();
  const rawKind = Array.isArray(params.kind) ? params.kind[0] : params.kind;
  const kind = isMadeForYouKind(rawKind) ? rawKind : "daily";
  const definition = madeForYouDefinition(kind);
  const { user, status } = useAuth();
  const isOnline = useOnlineStatus();
  const scope = user?.id ?? status;
  const accountScope = user?.id ?? "anonymous";
  const needsHistory = kind !== "offline";
  const needsLibrary = kind !== "offline";

  const stats = useApiData<StatsHomePayload>(
    withAccountScope("/api/stats/home", scope),
    { recentlyPlayed: [], mostPlayed: [] },
    { enabled: status !== "loading" && needsHistory, keepPreviousData: true },
  );
  const library = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", scope),
    { songs: [] },
    { enabled: status !== "loading" && needsLibrary, keepPreviousData: true },
  );
  const offlineRecords = useOfflineStore((state) => state.records);
  const offlineHydrated = useOfflineStore((state) => state.hydrated);
  const likedSongIds = useLikesStore((state) => state.likedSongIds);
  const readyOfflineSongs = useMemo(
    () =>
      Object.values(offlineRecords)
        .filter(
          (record) =>
            record.accountScope === accountScope &&
            record.status === "ready" &&
            record.scopes.some((recordScope) => recordScope !== PLAYBACK_CACHE_SCOPE),
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((record) => record.song),
    [accountScope, offlineRecords],
  );
  const seeds = useMemo(() => dailyMixSeeds(stats.data), [stats.data]);
  const [recommendations, setRecommendations] = useState<PlayerSong[]>([]);
  const [recommendationRevision, setRecommendationRevision] = useState(0);

  useEffect(() => {
    let active = true;
    if (kind !== "daily" || !isOnline || seeds.length === 0) {
      setRecommendations([]);
      return () => {
        active = false;
      };
    }
    void fetchRecommendations({
      contextKey: "playlist:made-for-you-daily",
      seeds,
      exclude: seeds,
      limit: 18,
    })
      .then((tracks) => {
        if (active) setRecommendations(tracks.map(recommendationToPlayerSong));
      })
      .catch(() => {
        if (active) setRecommendations([]);
      });
    return () => {
      active = false;
    };
  }, [isOnline, kind, recommendationRevision, seeds]);

  const songs = useMemo(
    () =>
      buildMadeForYouSongs(kind, {
        librarySongs: library.data.songs,
        readyOfflineSongs,
        recentlyPlayed: stats.data.recentlyPlayed,
        mostPlayed: stats.data.mostPlayed,
        likedSongIds: new Set(Object.keys(likedSongIds)),
        recommendations,
        rotationKey: madeForYouRotationKey(kind),
      }),
    [kind, library.data.songs, likedSongIds, readyOfflineSongs, recommendations, stats.data],
  );
  const playlistId = `made-for-you-${kind}`;
  const payload = useMemo<PlaylistPayload>(
    () => ({
      playlist: {
        id: playlistId,
        name: definition.name,
        imageUrl: null,
        description: definition.description,
        editable: false,
        deletable: false,
      },
      songs,
      likedSongIds: null,
    }),
    [definition.description, definition.name, playlistId, songs],
  );
  const sourceLoading =
    kind === "offline"
      ? !offlineHydrated
      : (stats.loading || library.loading || status === "loading") && songs.length === 0;
  const sourceError = songs.length === 0 ? stats.error || library.error : null;
  const retry = () => {
    if (needsHistory) stats.retry();
    if (needsLibrary) library.retry();
    setRecommendationRevision((revision) => revision + 1);
  };

  return (
    <PlaylistDetailScreen
      playlistId={playlistId}
      queueContextKey={`playlist:${playlistId}`}
      localPayload={payload}
      localLoading={sourceLoading}
      localError={sourceError}
      onLocalRetry={retry}
      coverContent={<MadeForYouCover kind={kind} />}
      showDownloadAction={false}
      emptyTitle={kind === "offline" ? "No downloads yet" : "Build your listening history"}
      emptySubtitle={
        kind === "offline"
          ? "Download songs and they will rotate through this mix."
          : "Listen to and like more music to shape this playlist."
      }
    />
  );
}
