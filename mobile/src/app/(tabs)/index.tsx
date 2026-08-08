import { useEffect, useMemo } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmailVerificationBanner } from "@/components/EmailVerificationBanner";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { ScrollerTile } from "@/components/song/ScrollerTile";
import { PlaylistScrollerTile } from "@/components/playlist/PlaylistScrollerTile";
import { ErrorText } from "@/components/ui/States";
import {
  type DiscoverPlaylistsPayload,
  type HomePayload,
  type StatsHomePayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playSongs } from "@/audio/actions";
import { usePlayerStore } from "@/store/player";
import { useLikesStore } from "@/store/likes";
import { colors } from "@/theme";
import type { PlayerSong } from "@/types/player";

function greetingForNow(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function SectionTitle({ title }: { title: string }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text
        style={{
          color: colors.foreground,
          fontSize: 22,
          fontWeight: "700",
          letterSpacing: -0.35,
        }}
      >
        {title}
      </Text>
    </View>
  );
}

function HScroller({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      decelerationRate="fast"
      snapToInterval={176}
      contentContainerStyle={{ gap: 12, paddingRight: 20 }}
    >
      {children}
    </ScrollView>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { user, status } = useAuth();
  const scope = user?.id ?? status;

  const { data: homeData, loading, error } = useApiData<HomePayload>(
    withAccountScope("/api/home", scope),
    { likedSongIds: null },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const mergeInitialLikes = useLikesStore((s) => s.mergeInitial);
  useEffect(() => {
    if (Array.isArray(homeData.likedSongIds)) mergeInitialLikes(homeData.likedSongIds);
  }, [mergeInitialLikes, homeData.likedSongIds]);

  const { data: statsData } = useApiData<StatsHomePayload>(
    withAccountScope("/api/stats/home", scope),
    { recentlyPlayed: [], mostPlayed: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  // The Discover first row is now auto-updating PLAYLISTS (Top 50 + the YouTube
  // Music Discover Mix), not individual tracks. Each card opens its detail screen.
  const { data: discoverData } = useApiData<DiscoverPlaylistsPayload>(
    "/api/discover/playlists",
    { playlists: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const discoverPlaylists = discoverData.playlists;

  const currentSongId = usePlayerStore((s) => s.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);

  const recentlyPlayed = statsData.recentlyPlayed as PlayerSong[];
  const mostPlayed = statsData.mostPlayed;
  const mostPlayedSongs = useMemo(() => mostPlayed.map((entry) => entry.song), [mostPlayed]);

  const playScroller = (songs: PlayerSong[], index: number) => {
    const song = songs[index];
    if (!song) return;
    if (song.id === currentSongId) {
      toggle();
      return;
    }
    playSongs(songs, index);
  };

  if ((loading && (homeData.likedSongIds?.length ?? 0) === 0) || status === "loading") {
    return (
      <Screen ambience="none">
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
          <ActivityIndicator color={colors.foreground} />
          <Text style={{ color: colors.muted, fontSize: 14 }}>Loading your library…</Text>
        </View>
      </Screen>
    );
  }

  const firstName = user?.name?.trim().split(/\s+/)[0];
  const greeting = firstName ? `${greetingForNow()}, ${firstName}` : greetingForNow();

  return (
    <Screen ambience="none">
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingBottom: CONTENT_BOTTOM_INSET,
          paddingHorizontal: 16,
          paddingTop: 14,
        }}
      >
        <View style={{ marginBottom: 28 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View style={{ minWidth: 0, flex: 1 }}>
              <Text
                style={{
                  color: colors.muted,
                  fontSize: 13,
                  lineHeight: 18,
                  fontWeight: "600",
                }}
              >
                {greeting}
              </Text>
              <Text
                style={{
                  marginTop: 4,
                  color: colors.foreground,
                  fontSize: 34,
                  lineHeight: 39,
                  fontWeight: "700",
                  letterSpacing: -0.9,
                }}
              >
                Listen now
              </Text>
            </View>
            <ProfileButton size={40} />
          </View>
        </View>

        <View style={{ marginHorizontal: -16, marginBottom: 10 }}>
          <EmailVerificationBanner />
        </View>
        {error ? <View className="mb-4"><ErrorText>{error}</ErrorText></View> : null}

        {discoverPlaylists.length > 0 ? (
          <View style={{ marginBottom: 34 }}>
            <SectionTitle title="Discover" />
            <HScroller>
              {discoverPlaylists.map((pl) => (
                <PlaylistScrollerTile
                  key={pl.id}
                  name={pl.name}
                  subtitle={pl.songsCount > 0 ? `Playlist • ${pl.songsCount} songs` : "Playlist"}
                  imageUrl={pl.imageUrl}
                  onPress={() => router.push(`/playlist/${pl.id}`)}
                />
              ))}
            </HScroller>
          </View>
        ) : null}

        {recentlyPlayed.length > 0 ? (
          <View style={{ marginBottom: 34 }}>
            <SectionTitle title="Continue listening" />
            <HScroller>
              {recentlyPlayed.map((song, index) => (
                <ScrollerTile
                  key={song.id}
                  title={song.title}
                  artist={song.artist}
                  songId={song.id}
                  imageUrl={song.imageUrl}
                  networkImageUrl={song.networkImageUrl}
                  active={currentSongId === song.id}
                  isPlaying={currentSongId === song.id && isPlaying}
                  onPress={() => playScroller(recentlyPlayed, index)}
                />
              ))}
            </HScroller>
          </View>
        ) : null}

        {mostPlayed.length > 0 ? (
          <View style={{ marginBottom: 34 }}>
            <SectionTitle title="Most played" />
            <HScroller>
              {mostPlayed.map((entry, index) => {
                const song = entry.song;
                return (
                  <ScrollerTile
                    key={song.id}
                    title={song.title}
                    artist={song.artist}
                    songId={song.id}
                    imageUrl={song.imageUrl}
                    networkImageUrl={song.networkImageUrl}
                    subtitle={entry.playCount > 0 ? `${entry.playCount} ${entry.playCount === 1 ? "play" : "plays"}` : undefined}
                    active={currentSongId === song.id}
                    isPlaying={currentSongId === song.id && isPlaying}
                    onPress={() => playScroller(mostPlayedSongs, index)}
                  />
                );
              })}
            </HScroller>
          </View>
        ) : null}

        {discoverPlaylists.length === 0 && recentlyPlayed.length === 0 && mostPlayed.length === 0 ? (
          <View
            style={{
              marginTop: 36,
              alignItems: "center",
              paddingHorizontal: 28,
              paddingVertical: 24,
            }}
          >
            <Text style={{ color: colors.foreground, fontSize: 17, fontWeight: "700" }}>
              Nothing here yet
            </Text>
            <Text
              style={{
                marginTop: 7,
                maxWidth: 270,
                color: colors.muted,
                fontSize: 14,
                lineHeight: 20,
                textAlign: "center",
              }}
            >
              Start playing something and it will appear here.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
