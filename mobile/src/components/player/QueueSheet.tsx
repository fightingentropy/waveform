import { useMemo } from "react";
import { FlatList, Text, View } from "react-native";
import { Plus, Sparkles, X } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { addRecommendationToContext, skipRecommendation } from "@/lib/smart-shuffle-actions";
import { getUpcomingPlaybackIndices, usePlayerStore } from "@/store/player";
import { getOfflineAccountScope, keyFor, useOfflineStore } from "@/store/offline";
import type { PlayerSong } from "@/types/player";

const MONO_ACTIVE = "rgba(255,255,255,0.94)";
const MONO_PRIMARY = "rgba(255,255,255,0.86)";
const MONO_SECONDARY = "rgba(255,255,255,0.58)";
const MONO_TERTIARY = "rgba(255,255,255,0.42)";

// Current song highlighted + "Up Next" (in playback order — shuffle shows the
// redo stack then the pool, via getUpcomingPlaybackIndices). Tap to jump, X to remove.
export function QueueSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const isOnline = useOnlineStatus();
  const offlineRecords = useOfflineStore((s) => s.records);
  const queue = usePlayerStore((s) => s.queue);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentSong = usePlayerStore((s) => s.currentSong);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const playFuture = usePlayerStore((s) => s.playFuture);
  const shuffleRemaining = usePlayerStore((s) => s.shuffleRemaining);
  const recommendedIds = usePlayerStore((s) => s.recommendedIds);
  const advanceToIndex = usePlayerStore((s) => s.advanceToIndex);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);

  const upcoming = useMemo(
    () =>
      getUpcomingPlaybackIndices(queue.length, currentIndex, queue.length, {
        shuffle,
        repeatMode,
        playFuture,
        shuffleRemaining,
      }),
    [queue.length, currentIndex, shuffle, repeatMode, playFuture, shuffleRemaining],
  );

  // A Smart Shuffle recommendation: sparkle by the title, a trailing [+] to Add
  // it to the queue's context (like / add to playlist), and the [X] becomes Skip
  // (removes + blocklists so it isn't recommended again). Membership is the
  // store's recommendedIds Set, not a flag on the song (the id changes on staging).
  const renderRow = (song: PlayerSong, index: number, current = false) => {
    const isRec = recommendedIds.has(song.id);
    const record = offlineRecords[keyFor(getOfflineAccountScope(), song.id)];
    const deviceLocal =
      song.source === "offline" ||
      song.source === "browser-local" ||
      song.source === "picked-file" ||
      /^(file|blob|data):/i.test(song.audioUrl);
    const unavailable =
      !current &&
      !isOnline &&
      !record?.audioPath &&
      !deviceLocal;
    return (
      <View
        className="flex-row items-center gap-3 px-4"
        style={{ minHeight: 60, opacity: unavailable ? 0.45 : 1 }}
      >
        <PressableScale
          scaleTo={1}
          onPress={current || unavailable ? undefined : () => advanceToIndex(index)}
          accessibilityRole={current ? "text" : "button"}
          accessibilityState={{ disabled: unavailable }}
          accessibilityLabel={current ? `Now playing ${song.title}` : `Play ${song.title}`}
          className="min-w-0 flex-1 flex-row items-center gap-3"
        >
          <View
            style={{
              width: 44,
              height: 44,
              overflow: "hidden",
              borderRadius: 8,
              borderCurve: "continuous",
            }}
          >
            <CoverImage
              src={song.imageUrl}
              networkSrc={song.networkImageUrl}
              offlineSongId={song.id}
              style={{ width: "100%", height: "100%" }}
              recyclingKey={song.id}
            />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-1.5">
              {isRec ? <Sparkles size={13} color={MONO_SECONDARY} /> : null}
              <Text
                numberOfLines={1}
                style={{
                  color: current ? MONO_ACTIVE : MONO_PRIMARY,
                  flexShrink: 1,
                  fontSize: 14,
                  fontWeight: current ? "600" : "500",
                }}
              >
                {song.title}
              </Text>
            </View>
            <Text numberOfLines={1} className="text-xs" style={{ color: MONO_SECONDARY }}>
              {unavailable ? `${song.artist} · Not downloaded` : song.artist}
            </Text>
          </View>
        </PressableScale>
        {isRec ? (
          <PressableScale
            onPress={() => void addRecommendationToContext(song, index)}
            accessibilityRole="button"
            accessibilityLabel={`Add ${song.title}`}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Plus size={19} color={MONO_PRIMARY} />
          </PressableScale>
        ) : null}
        {current ? null : (
          <PressableScale
            onPress={() => (isRec ? skipRecommendation(song, index) : removeFromQueue(index))}
            accessibilityRole="button"
            accessibilityLabel={isRec ? `Skip ${song.title}` : `Remove ${song.title}`}
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <X size={18} color={MONO_SECONDARY} />
          </PressableScale>
        )}
      </View>
    );
  };

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.8} zIndex={200}>
      <FlatList
        data={upcoming}
        keyExtractor={(i) => String(i)}
        extraData={recommendedIds}
        renderItem={({ item }) => renderRow(queue[item], item)}
        ListHeaderComponent={
          <View className="pb-2 pt-1">
            <Text className="mb-3 px-4" style={{ color: MONO_ACTIVE, fontSize: 20, fontWeight: "600" }}>
              Queue
            </Text>
            {currentSong ? (
              <>
                <Text
                  className="mb-1 px-4 text-xs font-semibold uppercase tracking-wide"
                  style={{ color: MONO_TERTIARY }}
                >
                  Now playing
                </Text>
                {renderRow(currentSong, currentIndex, true)}
                <Text
                  className="mb-1 mt-3 px-4 text-xs font-semibold uppercase tracking-wide"
                  style={{ color: MONO_TERTIARY }}
                >
                  Up next
                </Text>
              </>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <View className="items-center py-10">
            <Text style={{ color: MONO_SECONDARY }}>Nothing up next</Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 40 }}
      />
    </Sheet>
  );
}
