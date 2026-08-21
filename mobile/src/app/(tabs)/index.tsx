import { useEffect } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { EmailVerificationBanner } from "@/components/EmailVerificationBanner";
import { MadeForYouCover } from "@/components/playlist/MadeForYouCover";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { PlaylistScrollerTile } from "@/components/playlist/PlaylistScrollerTile";
import { ErrorText } from "@/components/ui/States";
import {
  type DiscoverPlaylistsPayload,
  type HomePayload,
  useApiData,
  withAccountScope,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { MADE_FOR_YOU_DEFINITIONS } from "@/lib/made-for-you";
import { useLikesStore } from "@/store/likes";
import { colors } from "@/theme";

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

  // The Discover first row is now auto-updating PLAYLISTS (Top 50 + the YouTube
  // Music Discover Mix), not individual tracks. Each card opens its detail screen.
  const { data: discoverData } = useApiData<DiscoverPlaylistsPayload>(
    "/api/discover/playlists",
    { playlists: [] },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const discoverPlaylists = discoverData.playlists;

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

        <View style={{ marginBottom: 34 }}>
          <SectionTitle title="Made for you" />
          <HScroller>
            {MADE_FOR_YOU_DEFINITIONS.map((definition) => (
              <PlaylistScrollerTile
                key={definition.kind}
                name={definition.name}
                subtitle={definition.subtitle}
                cover={<MadeForYouCover kind={definition.kind} />}
                onPress={() =>
                  router.push({
                    pathname: "/made-for-you/[kind]",
                    params: { kind: definition.kind },
                  } as unknown as Href)
                }
              />
            ))}
          </HScroller>
        </View>

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

        {discoverPlaylists.length === 0 ? (
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
              Your music recommendations will appear here.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
