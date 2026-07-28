import { useMemo } from "react";
import { Text, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Music2, Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { SongGrid } from "@/components/song/SongGrid";
import { PressableScale } from "@/components/ui/PressableScale";
import { EmptyState, ErrorText } from "@/components/ui/States";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  type CatalogArtistPayload,
  type SearchIndexPayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { reconcileCatalogSongs } from "@/lib/catalog-reconciliation";
import { playSongs } from "@/audio/actions";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { keyFor, useOfflineStore } from "@/store/offline";
import { usePlayerStore } from "@/store/player";
import { colors } from "@/theme";

function compactCount(value: number | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export default function CatalogArtistScreen() {
  const insets = useSafeAreaInsets();
  const { source, id } = useLocalSearchParams<{ source: string; id: string }>();
  const { user, status } = useAuth();
  const isOnline = useOnlineStatus();
  const valid = source === "spotify" && typeof id === "string" && id.length > 0;
  const endpoint = valid ? `/api/catalog/spotify/artists/${encodeURIComponent(id)}` : "";
  const { data, loading, error, retry } = useApiData<CatalogArtistPayload>(
    withAccountScope(endpoint || "/api/catalog/spotify/artists/invalid", user?.id ?? status),
    { provider: "spotify", artist: null, songs: [] },
    { enabled: status !== "loading" && valid, keepPreviousData: false },
  );
  const library = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", user?.id ?? status),
    { songs: [] },
    { enabled: status !== "loading", keepPreviousData: true },
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

  const reconciledSongs = useMemo(
    () => reconcileCatalogSongs(data.songs, library.data.songs, readyDownloadedSongs),
    [data.songs, library.data.songs, readyDownloadedSongs],
  );
  const songs = useMemo(
    () =>
      isOnline
        ? reconciledSongs
        : reconciledSongs.filter(
            (song) => offlineRecords[keyFor(user?.id ?? "anonymous", song.id)]?.status === "ready",
          ),
    [isOnline, offlineRecords, reconciledSongs, user?.id],
  );
  const contextKey = `catalog-artist:spotify:${id ?? ""}`;
  const isThisContext = usePlayerStore((state) => state.queueContextKey === contextKey);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const togglePlay = usePlayerStore((state) => state.toggle);
  const followerCount = compactCount(data.artist?.followers);
  const details = useMemo(
    () => [followerCount ? `${followerCount} followers` : null, data.artist?.genres?.slice(0, 2).join(" · ") || null]
      .filter(Boolean)
      .join("  •  "),
    [data.artist?.genres, followerCount],
  );

  if (!valid) return <Redirect href="/search" />;

  const header = (
    <View>
      <View
        style={{
          paddingTop: insets.top + 52,
          paddingHorizontal: 20,
          paddingBottom: 20,
          alignItems: "center",
        }}
      >
        {loading && !data.artist ? (
          <>
            <Skeleton width={156} height={156} radius={78} />
            <View style={{ marginTop: 20 }}>
              <Skeleton width={190} height={30} radius={8} />
            </View>
          </>
        ) : (
          <>
            <View
              style={{
                width: 156,
                height: 156,
                borderRadius: 78,
                overflow: "hidden",
                backgroundColor: colors.card,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 0.5,
                borderColor: colors.hairline,
              }}
            >
              {data.artist?.imageUrl ? (
                <CoverImage
                  src={data.artist.imageUrl}
                  style={{ width: "100%", height: "100%" }}
                  recyclingKey={`artist:${data.artist.id}`}
                />
              ) : (
                <Music2 size={52} color={colors.muted} />
              )}
            </View>
            <Text
              style={{
                marginTop: 20,
                color: colors.dim,
                fontSize: 11,
                fontWeight: "700",
                letterSpacing: 1.6,
              }}
            >
              ARTIST
            </Text>
            <Text
              numberOfLines={2}
              style={{
                marginTop: 6,
                color: colors.foreground,
                fontSize: 36,
                lineHeight: 40,
                fontWeight: "800",
                letterSpacing: -1.2,
                textAlign: "center",
              }}
            >
              {data.artist?.name ?? "Artist"}
            </Text>
            {details ? (
              <Text
                numberOfLines={2}
                style={{
                  marginTop: 8,
                  color: colors.muted,
                  fontSize: 13,
                  lineHeight: 18,
                  textAlign: "center",
                  textTransform: "capitalize",
                }}
              >
                {details}
              </Text>
            ) : null}
          </>
        )}
      </View>

      <View
        style={{
          minHeight: 70,
          paddingHorizontal: 20,
          paddingBottom: 10,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <View>
          <Text
            style={{
              color: colors.foreground,
              fontSize: 22,
              fontWeight: "700",
              letterSpacing: -0.45,
            }}
          >
            Popular
          </Text>
          {songs.length > 0 ? (
            <Text style={{ marginTop: 2, color: colors.muted, fontSize: 13 }}>
              {songs.length} {songs.length === 1 ? "song" : "songs"}
            </Text>
          ) : null}
        </View>
        {songs.length > 0 ? (
          <PressableScale
            onPress={() =>
              isThisContext
                ? togglePlay()
                : playSongs(songs, 0, {
                    respectShuffle: true,
                    contextKey,
                  })
            }
            accessibilityRole="button"
            accessibilityLabel={isThisContext && isPlaying ? "Pause" : "Play"}
            style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.foreground,
            }}
          >
            {isThisContext && isPlaying ? (
              <Pause size={26} color="#000" fill="#000" strokeWidth={0} />
            ) : (
              <Play size={27} color="#000" fill="#000" strokeWidth={0} style={{ marginLeft: 3 }} />
            )}
          </PressableScale>
        ) : null}
      </View>
      {error ? (
        <View style={{ paddingHorizontal: 20, paddingBottom: 12, gap: 8 }}>
          <ErrorText>{error}</ErrorText>
          <PressableScale
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel="Retry artist"
            style={{ alignSelf: "flex-start", paddingVertical: 4 }}
          >
            <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "700" }}>
              Try again
            </Text>
          </PressableScale>
        </View>
      ) : null}
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
        emptyComponent={
          loading ? null : (
            <EmptyState
              title={!isOnline ? "Connect to view songs" : error ? "Artist unavailable" : "No songs available"}
              subtitle={
                !isOnline
                  ? "Artist songs are streamed from Spotify."
                  : error
                    ? "Try again when Spotify is reachable."
                    : "Spotify returned no popular songs."
              }
            />
          )
        }
      />
    </View>
  );
}
