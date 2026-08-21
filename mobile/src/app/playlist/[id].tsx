import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { MoreHorizontal, Music, Pause, Pencil, Play, Shuffle, Sparkles, Trash2 } from "lucide-react-native";
import { BatchDownloadButton } from "@/components/song/BatchDownloadButton";
import { SongGrid } from "@/components/song/SongGrid";
import { SongSortBar } from "@/components/song/SongSortBar";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { EmptyState, ErrorText } from "@/components/ui/States";
import {
  type PlaylistPayload,
  type SearchIndexPayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { isProviderReadThroughRequest } from "@/lib/api-timeout-policy";
import { useAuth } from "@/lib/auth";
import { reconcileCatalogSongs } from "@/lib/catalog-reconciliation";
import { apiFetch } from "@/lib/http";
import { withRequestTimeout } from "@/lib/request-timeout";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { deletePlaylist, renamePlaylist } from "@/lib/playlist-actions";
import { canDeletePlaylist } from "@/lib/playlist-policy";
import { playSongs } from "@/audio/actions";
import { publishPlaybackState } from "@/audio/playback-sync";
import { useLikesStore } from "@/store/likes";
import { usePlayerStore } from "@/store/player";
import { keyFor, useOfflineStore } from "@/store/offline";
import { compareSongsForSort, sortSongs, useSongSort } from "@/store/song-sort";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

type PlaylistDetailScreenProps = {
  playlistId?: string;
  apiPath?: string;
  queueContextKey?: `playlist:${string}`;
  localPayload?: PlaylistPayload;
  localLoading?: boolean;
  localError?: string | null;
  onLocalRetry?: () => void;
  coverContent?: ReactElement;
  showDownloadAction?: boolean;
  emptyTitle?: string;
  emptySubtitle?: string;
};

export function PlaylistDetailScreen({
  playlistId,
  apiPath,
  queueContextKey,
  localPayload,
  localLoading = false,
  localError = null,
  onLocalRetry,
  coverContent,
  showDownloadAction = true,
  emptyTitle,
  emptySubtitle,
}: PlaylistDetailScreenProps = {}) {
  const insets = useSafeAreaInsets();
  const { id: routeId } = useLocalSearchParams<{ id: string }>();
  const id = playlistId ?? routeId;
  const { user, status } = useAuth();
  const isOnline = useOnlineStatus();
  const requestPath = apiPath ?? `/api/playlist/${id}`;
  // Home's Top 50 and YouTube mix routes use the normal /playlist/[id]
  // navigator, so apiPath is absent even though the resolved request is still
  // provider-backed. Classify the actual request path to preserve local-first
  // reconciliation and offline filtering on every entry point.
  const providerReadThrough = !localPayload && isProviderReadThroughRequest(requestPath);
  const remotePlaylist = useApiData<PlaylistPayload>(
    withAccountScope(requestPath, user?.id ?? status),
    // Unknown until the server answers. Treating the loading state as an
    // authoritative empty set would briefly clear every heart in the global
    // likes store; catalog/read-through playlists deliberately return null too.
    { playlist: null, songs: [], likedSongIds: null },
    {
      enabled: !localPayload && status !== "loading" && !!id,
      keepPreviousData: !providerReadThrough,
    },
  );
  const data = localPayload ?? remotePlaylist.data;
  const loading = localPayload ? localLoading : remotePlaylist.loading;
  const error = localPayload ? localError : remotePlaylist.error;
  const retry = localPayload ? (onLocalRetry ?? remotePlaylist.retry) : remotePlaylist.retry;
  const library = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", user?.id ?? status),
    { songs: [] },
    { enabled: status !== "loading" && providerReadThrough, keepPreviousData: true },
  );
  const offlineRecords = useOfflineStore((state) => state.records);
  const accountScope = user?.id ?? "anonymous";
  const readyDownloadedSongs = useMemo(
    () =>
      Object.values(offlineRecords)
        .filter((record) => record.accountScope === accountScope && record.status === "ready")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((record) => record.song),
    [accountScope, offlineRecords],
  );
  const spotifyCatalogPlaylist =
    !localPayload && !!apiPath && apiPath.startsWith("/api/catalog/spotify/playlists/");
  const [additionalSongs, setAdditionalSongs] = useState<PlaylistPayload["songs"]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const loadMoreRequestRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setAdditionalSongs([]);
    setNextOffset(data.page?.nextOffset ?? null);
    setLoadMoreError(null);
  }, [apiPath, data.page?.nextOffset, data.page?.offset, id]);
  useEffect(() => {
    setLoadingMore(false);
    return () => {
      loadMoreRequestRef.current?.abort();
      loadMoreRequestRef.current = null;
    };
  }, [apiPath, id]);
  const mergeInitialLikes = useLikesStore((s) => s.mergeInitial);
  useEffect(() => {
    // Only merge when the server actually sent a like set. A converted folder
    // returns likedSongIds=null when the mini's like set is unreachable; merging
    // (non-additive) on null/non-array would wipe every local-server heart, so
    // skip it and keep the current hearts until a successful liked/library load.
    if (Array.isArray(data.likedSongIds)) mergeInitialLikes(data.likedSongIds);
  }, [mergeInitialLikes, data.likedSongIds]);

  // Tag the queue with this playlist so the big Play button mirrors the player
  // (Pause/resume vs. starting over), exactly like the Liked Songs screen.
  const contextKey = queueContextKey ?? (`playlist:${id}` as const);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const smartShuffleEnabled = usePlayerStore((s) => s.smartShuffleEnabled);
  const openListeningModes = useUiStore((s) => s.openListeningModes);
  const isThisContext = usePlayerStore((s) => s.queueContextKey === contextKey);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.toggle);

  // Apply the user's chosen sort for this playlist (Date added / Title / …); the
  // sorted list drives Play, batch download, and the rows so taps stay in sync.
  const sort = useSongSort(contextKey);
  const sourceSongs = useMemo(() => {
    if (additionalSongs.length === 0) return data.songs;
    const seen = new Set<string>();
    return [...data.songs, ...additionalSongs].filter((song) => {
      if (seen.has(song.id)) return false;
      seen.add(song.id);
      return true;
    });
  }, [additionalSongs, data.songs]);
  const reconciledSongs = useMemo(
    () =>
      providerReadThrough
        ? reconcileCatalogSongs(sourceSongs, library.data.songs, readyDownloadedSongs)
        : sourceSongs,
    [library.data.songs, providerReadThrough, readyDownloadedSongs, sourceSongs],
  );
  const availableSongs = useMemo(
    () =>
      providerReadThrough && !isOnline
        ? reconciledSongs.filter(
            (song) => offlineRecords[keyFor(user?.id ?? "anonymous", song.id)]?.status === "ready",
          )
        : reconciledSongs,
    [isOnline, offlineRecords, providerReadThrough, reconciledSongs, user?.id],
  );
  const songs = useMemo(() => sortSongs(availableSongs, sort), [availableSongs, sort]);
  const count = songs.length;
  const totalCount = data.page?.totalCount ?? data.playlist?.trackCount ?? sourceSongs.length;
  const countLabel =
    spotifyCatalogPlaylist && isOnline && totalCount > sourceSongs.length
      ? `${sourceSongs.length} of ${totalCount} songs`
      : `${count} ${count === 1 ? "song" : "songs"}`;
  const name = data.playlist?.name ?? "Playlist";
  const cover = data.playlist?.imageUrl ?? songs[0]?.imageUrl ?? null;
  const showPause = isThisContext && isPlaying;

  // Editable = D1-backed (a converted folder or a native playlist). Folder-backed
  // playlists (local-folder-*) can be renamed + edited but NOT deleted in-app
  // (that would mean deleting files on the server), so the worker rejects it.
  const router = useRouter();
  const openNamePrompt = useUiStore((s) => s.openNamePrompt);
  const [menuOpen, setMenuOpen] = useState(false);
  const editable = !!data.playlist?.editable;
  const canDelete = data.playlist ? canDeletePlaylist(data.playlist) : false;
  // Stable so memoized song rows don't re-render every frame.
  const playlistContext = useMemo(
    () => (editable && typeof id === "string" ? { id, name } : undefined),
    [editable, id, name],
  );

  const loadPages = useCallback(async (loadAll: boolean) => {
    if (
      !spotifyCatalogPlaylist ||
      !apiPath ||
      nextOffset === null ||
      loadMoreRequestRef.current ||
      !isOnline ||
      status === "loading"
    ) {
      return;
    }
    const controller = new AbortController();
    loadMoreRequestRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError(null);
    let extendedActiveQueue = false;
    try {
      let offset: number | null = nextOffset;
      do {
        // Full-queue hydration belongs to the queue that started it. A context
        // switch can happen while this screen stays mounted, so stop before the
        // next provider request instead of downloading the rest of an abandoned
        // 10k-track playlist. Manual onEndReached paging remains independent.
        if (loadAll && usePlayerStore.getState().queueContextKey !== contextKey) break;
        const separator = apiPath.includes("?") ? "&" : "?";
        const pagePath = withAccountScope(
          `${apiPath}${separator}offset=${offset}&limit=100`,
          user?.id ?? status,
        );
        const response = await withRequestTimeout(
          (signal) => apiFetch(pagePath, { cache: "no-store", signal }),
          { timeoutMs: 15_000, signal: controller.signal },
        );
        const payload = (await response.json().catch(() => null)) as
          | (PlaylistPayload & { error?: string })
          | null;
        if (!response.ok || !payload) {
          throw new Error(payload?.error || `Couldn't load more songs (${response.status})`);
        }
        if (controller.signal.aborted) return;
        if (loadAll && usePlayerStore.getState().queueContextKey !== contextKey) break;

        setAdditionalSongs((current) => {
          const seen = new Set([...data.songs, ...current].map((song) => song.id));
          const additions = payload.songs.filter((song) => !seen.has(song.id) && seen.add(song.id));
          return additions.length > 0 ? [...current, ...additions] : current;
        });

        // If this playlist is the active queue, extend it in place as pages
        // arrive. Playback starts immediately from the first page, while the
        // complete Spotify playlist hydrates in the background without
        // restarting the current song or corrupting history/shuffle indices.
        const queueSongs = sortSongs(
          reconcileCatalogSongs(payload.songs, library.data.songs, readyDownloadedSongs),
          sort,
        );
        const queueBefore = usePlayerStore.getState().queue.length;
        usePlayerStore.getState().appendToQueue(queueSongs, contextKey, {
          compare: (a, b) => compareSongsForSort(a, b, sort),
          // sortSongs reverses stable equal-key runs for descending order. Later
          // provider pages therefore belong before earlier pages on a tie.
          incomingBeforeEqual: sort.dir === "desc",
        });
        const playerAfter = usePlayerStore.getState();
        if (playerAfter.queueContextKey === contextKey && playerAfter.queue.length > queueBefore) {
          extendedActiveQueue = true;
        }

        const reportedNextOffset = payload.page?.nextOffset ?? null;
        // Both ends cap Spotify offsets at 10k. Require strict forward progress
        // so a provider total/count drift can never make the background hydrator
        // refetch a clamped terminal page forever.
        offset =
          reportedNextOffset !== null &&
          reportedNextOffset > offset &&
          reportedNextOffset <= 10_000
            ? reportedNextOffset
            : null;
        setNextOffset(offset);
      } while (loadAll && offset !== null && !controller.signal.aborted);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setLoadMoreError(cause instanceof Error ? cause.message : "Couldn't load more songs.");
    } finally {
      // appendToQueue deliberately suppresses per-page persistence. Publish the
      // fully hydrated (or safely partial, if interrupted) queue exactly once.
      if (extendedActiveQueue && usePlayerStore.getState().queueContextKey === contextKey) {
        void publishPlaybackState(true);
      }
      if (loadMoreRequestRef.current === controller) {
        loadMoreRequestRef.current = null;
        setLoadingMore(false);
      }
    }
  }, [
    apiPath,
    contextKey,
    data.songs,
    isOnline,
    library.data.songs,
    nextOffset,
    readyDownloadedSongs,
    sort,
    spotifyCatalogPlaylist,
    status,
    user?.id,
  ]);

  const loadMore = useCallback(() => {
    void loadPages(false);
  }, [loadPages]);

  useEffect(() => {
    if (isThisContext && spotifyCatalogPlaylist && isOnline && nextOffset !== null) {
      void loadPages(true);
    }
  }, [isOnline, isThisContext, loadPages, nextOffset, spotifyCatalogPlaylist]);

  const handleRename = () => {
    if (typeof id !== "string") return;
    openNamePrompt({
      title: "Rename playlist",
      initialValue: name,
      confirmLabel: "Save",
      onSubmit: (next) =>
        void renamePlaylist(id, next).catch((err) =>
          Alert.alert("Couldn't rename", err instanceof Error ? err.message : "Please try again."),
        ),
    });
  };

  const handleDelete = () => {
    if (typeof id !== "string") return;
    if (!isOnline) {
      Alert.alert("You're offline", "Connect to the internet to delete this playlist.");
      return;
    }
    Alert.alert("Delete playlist?", `“${name}” will be removed. Its songs will stay in your library.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void deletePlaylist(id)
            .then(() => router.back())
            .catch((err) => Alert.alert("Couldn't delete", err instanceof Error ? err.message : "Please try again.")),
      },
    ]);
  };

  // Neutral collection hero: artwork provides the color, while the surrounding
  // interface stays on a flat material canvas.
  const header = (
    <View>
      <View
        style={{ paddingTop: insets.top + 52, paddingBottom: 18, paddingHorizontal: 20, alignItems: "center" }}
      >
        <View
          style={{
            borderRadius: 24,
            borderCurve: "continuous",
            shadowColor: "#000",
            shadowOpacity: 0.34,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 10 },
          }}
        >
          <View
            style={{
              width: 132,
              height: 132,
              borderRadius: 24,
              borderCurve: "continuous",
              overflow: "hidden",
              backgroundColor: colors.card,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 0.7,
              borderColor: colors.hairline,
            }}
          >
            {coverContent ?? (cover ? (
              <CoverImage src={cover} style={{ width: "100%", height: "100%" }} />
            ) : (
              <Music size={52} color={colors.muted} />
            ))}
          </View>
        </View>
        <Text numberOfLines={2} className="mt-5 text-center text-3xl font-extrabold" style={{ color: "#fff" }}>
          {name}
        </Text>
        <Text className="mt-1.5 text-sm font-medium" style={{ color: colors.muted }}>
          {countLabel}
        </Text>
      </View>

      {/* action row: download · shuffle · play (Spotify layout) */}
      <View
        className="flex-row items-center justify-between px-5 pb-3 pt-1"
        style={{ backgroundColor: colors.background }}
      >
        <View className="flex-row items-center" style={{ gap: 22 }}>
          {count > 0 && showDownloadAction ? (
            <BatchDownloadButton songs={songs} scope={contextKey} size={30} />
          ) : null}
          {editable ? (
            <PressableScale onPress={() => setMenuOpen(true)} hitSlop={8} accessibilityLabel="Playlist options">
              <View>
                <MoreHorizontal size={26} color={colors.iconIdle} />
              </View>
            </PressableScale>
          ) : null}
          {/* Listening mode: mirrors the Now Playing control — emerald Sparkles
              when Smart Shuffle is on, an emerald/idle Shuffle glyph otherwise.
              Tap opens the modes popup, scoped to this playlist. */}
          <PressableScale
            onPress={() => openListeningModes({ kind: "playlist", playlistId: id, editable })}
            hitSlop={8}
            accessibilityLabel="Listening modes"
          >
            <View>
              {smartShuffleEnabled ? (
                <Sparkles size={26} color={colors.emerald} />
              ) : (
                <Shuffle size={26} color={shuffle ? colors.emerald : colors.iconIdle} />
              )}
            </View>
          </PressableScale>
        </View>
        {count > 0 ? (
          <PressableScale
            onPress={() =>
              isThisContext
                ? togglePlay()
                : playSongs(songs, 0, {
                    respectShuffle: true,
                    contextKey,
                    contextMeta: { kind: "playlist", playlistId: id, editable },
                  })
            }
            accessibilityLabel={showPause ? "Pause" : "Play"}
            className="h-14 w-14 items-center justify-center rounded-full"
            style={{ backgroundColor: colors.emerald }}
          >
            <View>
              {showPause ? (
                <Pause size={28} color="#000" fill="#000" />
              ) : (
                <Play size={28} color="#000" fill="#000" style={{ marginLeft: 3 }} />
              )}
            </View>
          </PressableScale>
        ) : null}
      </View>
      {error ? (
        <View className="px-5 pb-3" style={{ gap: 8 }}>
          <ErrorText>{error}</ErrorText>
          <PressableScale
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="Retry playlist"
            style={{ alignSelf: "flex-start", paddingVertical: 4 }}
          >
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
              Try again
            </Text>
          </PressableScale>
        </View>
      ) : null}
      {count > 0 ? <SongSortBar context={contextKey} /> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SongGrid
        songs={songs}
        header={header}
        initialMode="list"
        showToggle={false}
        contextKey={contextKey}
        downloadScope={contextKey}
        playlistContext={playlistContext}
        onEndReached={spotifyCatalogPlaylist ? loadMore : undefined}
        footer={
          loadingMore ? (
            <View style={{ alignItems: "center", paddingVertical: 20 }}>
              <ActivityIndicator color={colors.muted} />
            </View>
          ) : loadMoreError ? (
            <View style={{ alignItems: "center", paddingHorizontal: 20, paddingVertical: 20, gap: 10 }}>
              <ErrorText>{loadMoreError}</ErrorText>
              <PressableScale
                onPress={loadMore}
                accessibilityRole="button"
                accessibilityLabel="Retry loading more songs"
                style={{ paddingHorizontal: 14, paddingVertical: 8 }}
              >
                <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
                  Try again
                </Text>
              </PressableScale>
            </View>
          ) : null
        }
        emptyComponent={
          loading ? null : (
            <EmptyState
              title={
                emptyTitle ??
                (providerReadThrough && !isOnline ? "Connect to view this playlist" : "This playlist is empty")
              }
              subtitle={
                emptySubtitle ??
                (providerReadThrough && !isOnline
                  ? "Downloaded matches from your library stay available offline."
                  : undefined)
              }
            />
          )
        }
      />
      <Sheet visible={menuOpen} onClose={() => setMenuOpen(false)} heightPct={0.4} zIndex={200}>
        <View className="border-b px-5 pb-3 pt-1" style={{ borderColor: colors.line }}>
          <Text numberOfLines={1} className="text-base font-semibold" style={{ color: colors.foreground }}>
            {name}
          </Text>
          <Text className="text-sm" style={{ color: colors.muted }}>
            {count} {count === 1 ? "song" : "songs"}
          </Text>
        </View>
        <PressableScale
          scaleTo={1}
          onPress={() => {
            setMenuOpen(false);
            handleRename();
          }}
          className="flex-row items-center gap-4 px-5 py-4"
        >
          <Pencil size={22} color={colors.foreground} />
          <Text className="text-base" style={{ color: colors.foreground }}>
            Rename
          </Text>
        </PressableScale>
        {canDelete ? (
          <PressableScale
            scaleTo={1}
            onPress={() => {
              setMenuOpen(false);
              handleDelete();
            }}
            className="flex-row items-center gap-4 px-5 py-4"
          >
            <Trash2 size={22} color="#ef4444" />
            <Text className="text-base" style={{ color: "#ef4444" }}>
              Delete playlist
            </Text>
          </PressableScale>
        ) : null}
      </Sheet>
    </View>
  );
}

export default function PlaylistScreen() {
  return <PlaylistDetailScreen />;
}
