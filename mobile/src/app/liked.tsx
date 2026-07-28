import { useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Heart, Pause, Play, Shuffle, Sparkles } from "lucide-react-native";
import { BatchDownloadButton } from "@/components/song/BatchDownloadButton";
import { SongGrid } from "@/components/song/SongGrid";
import { SongSortBar } from "@/components/song/SongSortBar";
import { PressableScale } from "@/components/ui/PressableScale";
import { EmptyState, ErrorText, SignedOutPrompt } from "@/components/ui/States";
import { type LikedPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playSongs } from "@/audio/actions";
import { useLikesStore } from "@/store/likes";
import { usePlayerStore } from "@/store/player";
import { sortSongs, useSongSort } from "@/store/song-sort";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

// Tags the queue when playback starts from Liked Songs, so the big Play button
// knows it owns the active playback (Pause/resume vs. starting over).
const LIKED_CONTEXT_KEY = "liked";

export default function LikedScreen() {
  const insets = useSafeAreaInsets();
  const { user, status } = useAuth();
  const { data, loading, error } = useApiData<LikedPayload>(
    withAccountScope("/api/liked", user?.id ?? status),
    { songs: [], likedSongIds: null },
    { enabled: status === "authenticated", keepPreviousData: true },
  );
  const mergeInitialLikes = useLikesStore((s) => s.mergeInitial);
  useEffect(() => {
    if (Array.isArray(data.likedSongIds)) mergeInitialLikes(data.likedSongIds);
  }, [mergeInitialLikes, data.likedSongIds]);

  const shuffle = usePlayerStore((s) => s.shuffle);
  const smartShuffleEnabled = usePlayerStore((s) => s.smartShuffleEnabled);
  const openListeningModes = useUiStore((s) => s.openListeningModes);
  // This collection "owns" playback when the queue was started from it (big
  // button or a row tap, both tagged "liked"). Then the button mirrors the
  // player — Pause while playing, resume while paused — instead of restarting.
  const isLikedContext = usePlayerStore((s) => s.queueContextKey === LIKED_CONTEXT_KEY);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.toggle);

  // Apply the user's chosen sort for this collection (Date added / Title / …).
  // The sorted list feeds the big Play button, batch download, and the rows alike
  // so a tap always plays what's visible.
  const sort = useSongSort(LIKED_CONTEXT_KEY);
  const songs = useMemo(() => sortSongs(data.songs, sort), [data.songs, sort]);
  const count = songs.length;
  const showPause = isLikedContext && isPlaying;

  if (status === "unauthenticated") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <SignedOutPrompt message="Sign in to see your Liked Songs." />
      </View>
    );
  }

  // Quiet, artwork-free collection header. The material and typography carry the
  // hierarchy without a decorative color wash.
  const header = (
    <View>
      <View
        style={{ paddingTop: insets.top + 52, paddingBottom: 18, paddingHorizontal: 20, alignItems: "center" }}
      >
        <View
          style={{
            width: 132,
            height: 132,
            borderRadius: 28,
            borderCurve: "continuous",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.surface,
            borderWidth: 0.7,
            borderColor: colors.hairline,
            shadowColor: "#000",
            shadowOpacity: 0.32,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 10 },
          }}
        >
          <Heart size={54} color={colors.emerald} fill={colors.emerald} />
        </View>
        <Text className="mt-5 text-3xl font-extrabold" style={{ color: "#fff" }}>
          Liked Songs
        </Text>
        <Text className="mt-1.5 text-sm font-medium" style={{ color: colors.muted }}>
          {count} {count === 1 ? "song" : "songs"}
        </Text>
      </View>

      {/* action row: download · shuffle · play (Spotify layout) */}
      <View
        className="flex-row items-center justify-between px-5 pb-3 pt-1"
        style={{ backgroundColor: colors.background }}
      >
        <View className="flex-row items-center" style={{ gap: 22 }}>
          {count > 0 ? <BatchDownloadButton songs={songs} scope="liked" size={30} /> : null}
          {/* Listening mode: mirrors the Now Playing control — emerald Sparkles
              when Smart Shuffle is on, an emerald/idle Shuffle glyph otherwise.
              Tap opens the modes popup, scoped to this collection. */}
          <PressableScale onPress={() => openListeningModes({ kind: "liked" })} hitSlop={8} accessibilityLabel="Listening modes">
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
              isLikedContext
                ? togglePlay()
                : playSongs(songs, 0, {
                    respectShuffle: true,
                    contextKey: LIKED_CONTEXT_KEY,
                    contextMeta: { kind: "liked" },
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
        <View className="px-5 pb-2">
          <ErrorText>{error}</ErrorText>
        </View>
      ) : null}
      {count > 0 ? <SongSortBar context={LIKED_CONTEXT_KEY} /> : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <SongGrid
        songs={songs}
        header={header}
        initialMode="list"
        showToggle={false}
        contextKey={LIKED_CONTEXT_KEY}
        emptyComponent={
          loading ? null : (
            <EmptyState title="No liked songs yet" subtitle="Tap the heart on any track to save it here." />
          )
        }
      />
    </View>
  );
}
