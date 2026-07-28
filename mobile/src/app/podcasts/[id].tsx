import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { fetch as expoFetch } from "expo/fetch";
import { Pause, Play } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { DownloadButton } from "@/components/song/DownloadButton";
import { EmptyState, ErrorText } from "@/components/ui/States";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { apiUrl } from "@/lib/http";
import {
  parsePodcastFeed,
  PODCAST_SHOWS,
  readPodcastFeedPrefix,
  type PodcastEpisode,
} from "@/lib/podcasts";
import { useUserPodcastsStore } from "@/store/user-podcasts";
import { formatTime } from "@/lib/format";
import { isEpisodeFinished, readAllEpisodeProgress } from "@/lib/podcast-progress";
import { playSongs } from "@/audio/actions";
import { usePlayerStore } from "@/store/player";
import { colors } from "@/theme";

export default function PodcastShowScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const userShow = useUserPodcastsStore((s) => s.shows.find((sh) => sh.id === id));
  const removeShow = useUserPodcastsStore((s) => s.removeShow);
  const show = PODCAST_SHOWS.find((s) => s.id === id) ?? userShow;
  const [episodes, setEpisodes] = useState<PodcastEpisode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentSongId = usePlayerStore((s) => s.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);

  useEffect(() => {
    if (!show) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setEpisodes(null);
    setError(null);
    (async () => {
      try {
        // User-added feeds are fetched directly (native has no CORS); built-in
        // shows go through the SSRF-guarded Worker proxy keyed by show id.
        const feedUrl = show.userAdded
          ? show.feedUrl
          : apiUrl(`/api/podcast-feeds/${encodeURIComponent(show.id)}`);
        const res = await expoFetch(feedUrl, {
          credentials: "include",
          signal: controller.signal,
          headers: { accept: "application/rss+xml, application/xml, text/xml, */*" },
        });
        if (!res.ok) throw new Error(`Could not load episodes (${res.status})`);
        const xml = await readPodcastFeedPrefix(res);
        const parsed = parsePodcastFeed(xml, show);
        if (!cancelled) setEpisodes(parsed);
      } catch (e) {
        if (!cancelled) {
          setError(
            controller.signal.aborted
              ? "Podcast feed timed out"
              : e instanceof Error
                ? e.message
                : "Could not load episodes",
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [show]);

  // MMKV reads are synchronous and the progress map can hold 200 entries. Read
  // and parse it once per screen refresh, not once for every rendered episode.
  const episodeProgress = useMemo(
    () => (episodes ? readAllEpisodeProgress() : null),
    [episodes, currentSongId, isPlaying],
  );

  if (!show) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <EmptyState title="Show not found" />
      </View>
    );
  }

  const renderEpisode = ({ item, index }: { item: PodcastEpisode; index: number }) => {
    const active = currentSongId === item.id;
    const progress = episodeProgress?.[item.id] ?? null;
    const finished = progress ? isEpisodeFinished(progress) : false;
    const inProgress = !finished && progress != null && progress.duration > 0 && progress.time > 0;
    const progressPct = inProgress
      ? Math.min(100, Math.max(0, (progress.time / progress.duration) * 100))
      : 0;
    const minutesLeft = inProgress ? Math.max(1, Math.ceil((progress.duration - progress.time) / 60)) : 0;
    return (
      <View className="flex-row items-center gap-3 px-4 py-3">
        <PressableScale
          scaleTo={1}
          onPress={() => (active ? toggle() : playSongs(episodes ?? [], index))}
          className="min-w-0 flex-1"
        >
          <Text numberOfLines={2} className="text-[15px] font-medium" style={{ color: active ? colors.emerald : colors.foreground }}>
            {item.title}
          </Text>
          <Text numberOfLines={1} className="mt-0.5 text-xs" style={{ color: colors.muted }}>
            {finished ? "Played · " : ""}
            {item.duration ? formatTime(item.duration) : ""}
            {item.publishedAt ? ` · ${new Date(item.publishedAt).toLocaleDateString()}` : ""}
          </Text>
          {inProgress ? (
            <View className="mt-1.5 flex-row items-center gap-2">
              <View className="h-1 flex-1 overflow-hidden rounded-full" style={{ backgroundColor: colors.line }}>
                <View className="h-full rounded-full" style={{ width: `${progressPct}%`, backgroundColor: colors.emerald }} />
              </View>
              <Text className="text-[11px]" style={{ color: colors.muted }}>{minutesLeft}m left</Text>
            </View>
          ) : null}
        </PressableScale>
        <DownloadButton song={item} size={20} />
        <PressableScale onPress={() => (active ? toggle() : playSongs(episodes ?? [], index))} hitSlop={8}>
          <View className="h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: colors.emerald }}>
            {active && isPlaying ? (
              <Pause size={16} color="#050505" fill="#050505" />
            ) : (
              <Play size={16} color="#050505" fill="#050505" style={{ marginLeft: 1 }} />
            )}
          </View>
        </PressableScale>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: show.title,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.foreground,
          headerShadowVisible: false,
        }}
      />
      {error ? (
        <View className="p-4"><ErrorText>{error}</ErrorText></View>
      ) : !episodes ? (
        <View className="items-center py-16"><ActivityIndicator color={colors.emerald} /></View>
      ) : (
        <FlatList
          data={episodes}
          keyExtractor={(e) => e.id}
          renderItem={renderEpisode}
          ListHeaderComponent={
            <View className="px-4 pb-2 pt-4">
              <View className="flex-row items-center gap-4">
                <View className="h-20 w-20 overflow-hidden rounded-lg" style={{ backgroundColor: colors.card }}>
                  <CoverImage src={show.imageUrl} style={{ width: "100%", height: "100%" }} />
                </View>
                <View className="min-w-0 flex-1">
                  <Text className="text-xl font-bold" style={{ color: colors.foreground }}>{show.title}</Text>
                  <Text className="text-sm" style={{ color: colors.muted }}>{show.author}</Text>
                </View>
              </View>
              {show.description ? (
                <Text className="mt-3 text-[13px] leading-5" style={{ color: colors.muted }}>
                  {show.description}
                </Text>
              ) : null}
              {show.userAdded ? (
                <PressableScale
                  scaleTo={1}
                  onPress={() => {
                    removeShow(show.id);
                    router.back();
                  }}
                  className="mt-4 self-start rounded-full px-4 py-2"
                  style={{ borderWidth: 1, borderColor: colors.line }}
                >
                  <Text className="text-[13px] font-semibold" style={{ color: colors.foreground }}>
                    Remove from your podcasts
                  </Text>
                </PressableScale>
              ) : null}
            </View>
          }
          ListEmptyComponent={<EmptyState title="No episodes" />}
          contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET }}
        />
      )}
    </View>
  );
}
