import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, TextInput, View, Text } from "react-native";
import { useRouter, type Href } from "expo-router";
import { ListMusic, Search as SearchIcon, UserRound } from "lucide-react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { SongListItem } from "@/components/song/SongListItem";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorText } from "@/components/ui/States";
import {
  type CatalogArtist,
  type CatalogPlaylist,
  type SearchCatalogPayload,
  type SearchIndexPayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toggleSongInList } from "@/audio/actions";
import {
  catalogRequestState,
  catalogSongKey,
  reconcileCatalogSongs,
} from "@/lib/catalog-reconciliation";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { keyFor, useOfflineStore } from "@/store/offline";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

type SearchableSong = { song: PlayerSong; title: string; artist: string };
type SearchFilter = "top" | "songs" | "artists" | "playlists";

function score({ title, artist }: SearchableSong, q: string): number {
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (artist.startsWith(q)) return 60;
  if (title.includes(q)) return 40;
  if (artist.includes(q)) return 20;
  return 0;
}

// Collapse case/punctuation so a library hit and its Spotify-catalog twin
// ("Revelries; Victoria Voss" vs "Revelries, Victoria Voss") dedupe to one row.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function SearchingCatalog() {
  return (
    <View className="flex-row items-center justify-center gap-2 px-4 py-5">
      <ActivityIndicator size="small" color={colors.muted} />
      <Text className="text-sm" style={{ color: colors.muted }}>
        Searching music…
      </Text>
    </View>
  );
}

function SearchFilterButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      scaleTo={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} results`}
      accessibilityState={{ selected: active }}
      style={{
        minHeight: 42,
        paddingHorizontal: 2,
        marginRight: 22,
        justifyContent: "center",
        borderBottomWidth: active ? 1.5 : 0,
        borderBottomColor: colors.foreground,
      }}
    >
      <Text
        style={{
          color: active ? colors.foreground : colors.muted,
          fontSize: 14,
          fontWeight: active ? "700" : "500",
        }}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

function ArtistResultRow({ artist, onPress }: { artist: CatalogArtist; onPress: () => void }) {
  return (
    <PressableScale
      scaleTo={0.99}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open artist ${artist.name}`}
      className="flex-row items-center"
      style={{ minHeight: 78, gap: 14, paddingHorizontal: 20, paddingVertical: 8 }}
    >
      <View
        style={{
          width: 62,
          height: 62,
          borderRadius: 31,
          overflow: "hidden",
          backgroundColor: colors.card,
          borderWidth: 0.5,
          borderColor: colors.hairline,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {artist.imageUrl ? (
          <CoverImage
            src={artist.imageUrl}
            style={{ width: "100%", height: "100%" }}
            recyclingKey={`artist:${artist.id}`}
          />
        ) : (
          <UserRound size={25} color={colors.muted} />
        )}
      </View>
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", letterSpacing: -0.2 }}
        >
          {artist.name}
        </Text>
        <Text numberOfLines={1} style={{ marginTop: 3, color: colors.muted, fontSize: 13 }}>
          Artist · Spotify
          {typeof artist.followers === "number"
            ? ` · ${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(artist.followers)} followers`
            : ""}
        </Text>
      </View>
    </PressableScale>
  );
}

function PlaylistResultRow({ playlist, onPress }: { playlist: CatalogPlaylist; onPress: () => void }) {
  const providerName = playlist.provider === "youtube" ? "YouTube" : "Spotify";
  const detail = [
    `${providerName} playlist`,
    playlist.ownerName || null,
    typeof playlist.trackCount === "number"
      ? `${playlist.trackCount} ${playlist.trackCount === 1 ? "song" : "songs"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <PressableScale
      scaleTo={0.99}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open playlist ${playlist.name}`}
      className="flex-row items-center"
      style={{ minHeight: 78, gap: 14, paddingHorizontal: 20, paddingVertical: 8 }}
    >
      <View
        style={{
          width: 62,
          height: 62,
          borderRadius: 10,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: colors.card,
          borderWidth: 0.5,
          borderColor: colors.hairline,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {playlist.imageUrl ? (
          <CoverImage
            src={playlist.imageUrl}
            style={{ width: "100%", height: "100%" }}
            recyclingKey={`playlist:${playlist.provider}:${playlist.id}`}
          />
        ) : (
          <ListMusic size={25} color={colors.muted} />
        )}
      </View>
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", letterSpacing: -0.2 }}
        >
          {playlist.name}
        </Text>
        <Text numberOfLines={1} style={{ marginTop: 3, color: colors.muted, fontSize: 13 }}>
          {detail}
        </Text>
      </View>
    </PressableScale>
  );
}

type SearchRow =
  | { kind: "header"; key: string; title: string }
  | { kind: "song"; key: string; song: PlayerSong; list: PlayerSong[]; index: number }
  | { kind: "artist"; key: string; artist: CatalogArtist }
  | { kind: "playlist"; key: string; playlist: CatalogPlaylist };

function addSongSection(out: SearchRow[], title: string, key: string, songs: PlayerSong[]) {
  if (songs.length === 0) return;
  out.push({ kind: "header", key: `hdr:${key}`, title });
  songs.forEach((song, index) =>
    out.push({ kind: "song", key: `${key}:${song.id}:${index}`, song, list: songs, index }),
  );
}

export default function SearchScreen() {
  const router = useRouter();
  const { user, status } = useAuth();
  const isOnline = useOnlineStatus();
  const offlineRecords = useOfflineStore((state) => state.records);
  const accountScope = user?.id ?? "anonymous";
  const { data, loading } = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", user?.id ?? status),
    { songs: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SearchFilter>("top");

  // Lowercase the library once when its index changes, rather than doing two
  // string allocations per song on every keystroke.
  const searchableSongs = useMemo<SearchableSong[]>(
    () =>
      data.songs.map((song) => ({
        song,
        title: song.title.toLowerCase(),
        artist: song.artist.toLowerCase(),
      })),
    [data.songs],
  );

  // Library matches remain instant and available offline.
  const localResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return searchableSongs
      .map((entry) => ({ song: entry.song, s: score(entry, q) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 100)
      .map((entry) => entry.song);
  }, [query, searchableSongs]);
  const visibleLocalResults = useMemo(
    () =>
      isOnline
        ? localResults
        : localResults.filter(
            (song) => offlineRecords[keyFor(accountScope, song.id)]?.status === "ready",
          ),
    [accountScope, isOnline, localResults, offlineRecords],
  );

  // Platform results are debounced and scoped to the signed-in account. A new
  // query clears the previous payload, preventing stale artists/playlists from
  // flashing under different text.
  const debouncedQuery = useDebouncedValue(query.trim(), 350);
  const catalogEnabled = debouncedQuery.length >= 2;
  const catalog = useApiData<SearchCatalogPayload>(
    withAccountScope(
      `/api/search/catalog?q=${encodeURIComponent(debouncedQuery)}`,
      user?.id ?? status,
    ),
    { query: "", results: [], playlists: [], artists: [], providers: {} },
    { enabled: catalogEnabled && status !== "loading", keepPreviousData: false },
  );
  const catalogState = catalogRequestState(
    query,
    debouncedQuery,
    catalog.data.query,
    catalog.loading,
    catalog.error,
  );
  const catalogIsCurrent = catalogState.dataIsCurrent;

  const libraryKeys = useMemo(
    () => new Set(visibleLocalResults.map(catalogSongKey)),
    [visibleLocalResults],
  );
  const readyDownloadedSongs = useMemo(
    () =>
      Object.values(offlineRecords)
        .filter((record) => record.accountScope === accountScope && record.status === "ready")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((record) => record.song),
    [accountScope, offlineRecords],
  );
  const catalogSongs = useMemo(() => {
    if (!catalogIsCurrent) return [];
    const reconciled = reconcileCatalogSongs(
      catalog.data.results ?? [],
      data.songs,
      readyDownloadedSongs,
    );
    return reconciled.filter(
      (song) =>
        !libraryKeys.has(catalogSongKey(song)) &&
        (isOnline || offlineRecords[keyFor(accountScope, song.id)]?.status === "ready"),
    );
  }, [
    accountScope,
    catalog.data.results,
    catalogIsCurrent,
    data.songs,
    isOnline,
    libraryKeys,
    offlineRecords,
    readyDownloadedSongs,
  ]);
  const artists = isOnline && catalogIsCurrent ? (catalog.data.artists ?? []) : [];
  const playlists = isOnline && catalogIsCurrent ? (catalog.data.playlists ?? []) : [];

  const rows = useMemo<SearchRow[]>(() => {
    const out: SearchRow[] = [];
    if (filter === "top" || filter === "artists") {
      const visibleArtists = filter === "top" ? artists.slice(0, 4) : artists;
      if (visibleArtists.length > 0) {
        out.push({ kind: "header", key: "hdr:artists", title: "Artists" });
        visibleArtists.forEach((artist) =>
          out.push({ kind: "artist", key: `artist:${artist.provider}:${artist.id}`, artist }),
        );
      }
    }
    if (filter === "top" || filter === "playlists") {
      const visiblePlaylists = filter === "top" ? playlists.slice(0, 8) : playlists;
      if (visiblePlaylists.length > 0) {
        out.push({ kind: "header", key: "hdr:playlists", title: "Playlists" });
        visiblePlaylists.forEach((playlist) =>
          out.push({
            kind: "playlist",
            key: `playlist:${playlist.provider}:${playlist.id}`,
            playlist,
          }),
        );
      }
    }
    if (filter === "top" || filter === "songs") {
      addSongSection(
        out,
        "In your library",
        "library",
        filter === "top" ? visibleLocalResults.slice(0, 12) : visibleLocalResults,
      );
      addSongSection(
        out,
        "Songs",
        "catalog",
        filter === "top" ? catalogSongs.slice(0, 18) : catalogSongs,
      );
    }
    return out;
  }, [artists, catalogSongs, filter, playlists, visibleLocalResults]);

  const catalogLoading = isOnline && catalogState.loading;
  const platformOffline = !isOnline && query.trim().length >= 2;
  const providerUnavailable =
    isOnline &&
    (catalogState.errorIsCurrent ||
      (catalogIsCurrent &&
        (catalog.data.providers?.spotify === "unavailable" ||
          catalog.data.providers?.youtube === "unavailable")));
  const hasQuery = query.trim().length > 0;

  return (
    <Screen>
      <View style={{ paddingHorizontal: 20, paddingBottom: 10, paddingTop: 18 }}>
        <View className="flex-row items-center gap-3" style={{ marginBottom: 16 }}>
          <ProfileButton size={38} />
          <Text
            style={{
              color: colors.foreground,
              fontSize: 34,
              fontWeight: "700",
              letterSpacing: -0.9,
              lineHeight: 40,
            }}
          >
            Search
          </Text>
        </View>
        <View
          style={{
            height: 50,
            borderRadius: 12,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: colors.surface,
            borderWidth: 0.5,
            borderColor: colors.line,
          }}
        >
          <View className="h-full flex-row items-center" style={{ gap: 11, paddingHorizontal: 17 }}>
            <SearchIcon size={21} color={query ? colors.foreground : colors.iconIdle} strokeWidth={2.2} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Songs, artists and playlists"
              placeholderTextColor={colors.muted}
              style={{
                flex: 1,
                height: 50,
                paddingVertical: 0,
                color: colors.foreground,
                fontSize: 16,
                fontWeight: "500",
              }}
              autoCorrect={false}
              maxLength={100}
              returnKeyType="search"
              clearButtonMode="while-editing"
            />
          </View>
        </View>

        {hasQuery ? (
          <View className="flex-row" style={{ paddingTop: 12 }}>
            <SearchFilterButton label="Top" active={filter === "top"} onPress={() => setFilter("top")} />
            <SearchFilterButton label="Songs" active={filter === "songs"} onPress={() => setFilter("songs")} />
            <SearchFilterButton label="Artists" active={filter === "artists"} onPress={() => setFilter("artists")} />
            <SearchFilterButton
              label="Playlists"
              active={filter === "playlists"}
              onPress={() => setFilter("playlists")}
            />
          </View>
        ) : null}
      </View>

      {loading && data.songs.length === 0 ? (
        <View style={{ gap: 14, paddingHorizontal: 20, paddingTop: 8 }}>
          {Array.from({ length: 8 }).map((_, index) => (
            <View key={index} className="flex-row items-center gap-3">
              <Skeleton width={52} height={52} radius={8} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={"70%"} height={14} />
                <Skeleton width={"40%"} height={12} />
              </View>
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => {
            if (item.kind === "header") {
              return (
                <Text
                  style={{
                    color: colors.foreground,
                    fontSize: 18,
                    fontWeight: "700",
                    letterSpacing: -0.3,
                    paddingHorizontal: 20,
                    paddingBottom: 6,
                    paddingTop: 22,
                  }}
                >
                  {item.title}
                </Text>
              );
            }
            if (item.kind === "artist") {
              return (
                <ArtistResultRow
                  artist={item.artist}
                  onPress={() =>
                    router.push({
                      pathname: "/search/artist/[source]/[id]",
                      params: { source: item.artist.provider, id: item.artist.id },
                    } as Href)
                  }
                />
              );
            }
            if (item.kind === "playlist") {
              return (
                <PlaylistResultRow
                  playlist={item.playlist}
                  onPress={() =>
                    router.push({
                      pathname: "/search/playlist/[source]/[id]",
                      params: { source: item.playlist.provider, id: item.playlist.id },
                    } as Href)
                  }
                />
              );
            }
            return (
              <SongListItem
                song={item.song}
                onPress={() => toggleSongInList(item.list, item.index)}
                showActions
              />
            );
          }}
          contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET, paddingTop: 2 }}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            catalogLoading ? (
              <SearchingCatalog />
            ) : platformOffline ? (
              <View style={{ paddingHorizontal: 20, paddingVertical: 18 }}>
                <ErrorText>Connect to search Spotify and YouTube. Your downloaded library is still available.</ErrorText>
              </View>
            ) : providerUnavailable ? (
              <View style={{ paddingHorizontal: 20, paddingVertical: 18, gap: 10 }}>
                <ErrorText>
                  {catalog.error ?? "Some platform results are temporarily unavailable."}
                </ErrorText>
                <PressableScale
                  onPress={catalog.retry}
                  accessibilityRole="button"
                  accessibilityLabel="Retry platform search"
                  style={{ alignSelf: "flex-start", paddingVertical: 6 }}
                >
                  <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>Try again</Text>
                </PressableScale>
              </View>
            ) : null
          }
          ListEmptyComponent={
            hasQuery && !catalogLoading ? (
              <EmptyState
                title="No results"
                subtitle={`Nothing in ${filter === "top" ? "music" : filter} matches “${query.trim()}”.`}
              />
            ) : null
          }
        />
      )}
    </Screen>
  );
}
