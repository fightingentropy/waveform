import { type ReactNode, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, runOnJS } from "react-native-reanimated";
import {
  CheckCircle2,
  CircleArrowDown,
  Heart,
  ListMusic,
  MicVocal,
  Moon,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
} from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { MarqueeText } from "@/components/ui/MarqueeText";
import { Sheet } from "@/components/ui/Sheet";
import { Scrubber } from "@/components/player/Scrubber";
import { LyricsView } from "@/components/player/LyricsView";
import { DownloadProgressRing } from "@/components/song/DownloadProgressRing";
import { useSongLike } from "@/components/song/useSongLike";
import { colors } from "@/theme";
import { selectionAsync } from "@/lib/haptics";
import { isDiscoverTrack, isRadioSong, isPodcastSong } from "@/lib/player-song";
import {
  type DownloadScope,
  getOfflineAccountScope,
  keyFor,
  useOfflineStore,
} from "@/store/offline";
import { formatPlaybackRate, nextPlaybackRate, usePlayerStore } from "@/store/player";
import { useUiStore } from "@/store/ui";
import type { PlayerSong } from "@/types/player";

const MONO_ACTIVE = "rgba(255,255,255,0.94)";
const MONO_IDLE = "rgba(255,255,255,0.48)";
const MONO_SECONDARY = "rgba(255,255,255,0.58)";
const MONO_HAIRLINE = "rgba(255,255,255,0.12)";

function PlainIconButton({
  children,
  onPress,
  onLongPress,
  accessibilityLabel,
  accessibilityHint,
  selected,
  disabled = false,
  size = 44,
}: {
  children: ReactNode;
  onPress: () => void;
  onLongPress?: () => void;
  accessibilityLabel: string;
  accessibilityHint?: string;
  selected?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  return (
    <PressableScale
      scaleTo={disabled ? 1 : 0.92}
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={
        onLongPress ? [{ name: "openModes", label: "Open listening modes" }] : undefined
      }
      onAccessibilityAction={
        onLongPress
          ? (event) => {
              if (event.nativeEvent.actionName === "openModes") onLongPress();
            }
          : undefined
      }
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.28 : 1,
      }}
    >
      {children}
    </PressableScale>
  );
}

function MonochromeLikeButton({ song }: { song: PlayerSong }) {
  const { liked, pending, canLike, toggle } = useSongLike(song);
  if (!canLike) return null;
  return (
    <PlainIconButton
      onPress={() => {
        void selectionAsync();
        toggle();
      }}
      disabled={pending}
      selected={liked}
      accessibilityLabel={
        liked ? `Remove ${song.title} from Liked Songs` : `Save ${song.title} to Liked Songs`
      }
    >
      <Heart
        size={22}
        color={liked ? MONO_ACTIVE : MONO_IDLE}
        fill={liked ? MONO_ACTIVE : "transparent"}
      />
    </PlainIconButton>
  );
}

function MonochromeDownloadButton({
  song,
  scope,
}: {
  song: PlayerSong;
  scope?: DownloadScope;
}) {
  const key = keyFor(getOfflineAccountScope(), song.id);
  const record = useOfflineStore((state) => state.records[key]);
  const progress = useOfflineStore((state) => state.progress[key]);
  const queueDownloads = useOfflineStore((state) => state.queueDownloads);
  const unpinScope = useOfflineStore((state) => state.unpinScope);

  if (isRadioSong(song) || isDiscoverTrack(song)) return null;

  const songScope: DownloadScope = scope ?? `song:${song.id}`;
  const status = record?.scopes.includes(songScope) ? record.status : undefined;
  const active = status === "downloading" || status === "queued";

  const onPress = () => {
    void selectionAsync();
    if (status === "ready" || active) void unpinScope(song.id, songScope);
    else void queueDownloads([song], songScope);
  };

  const stopSquare = (
    <View
      style={{
        width: 6,
        height: 6,
        borderRadius: 1.5,
        backgroundColor: MONO_ACTIVE,
      }}
    />
  );

  return (
    <PlainIconButton
      onPress={onPress}
      selected={status === "ready"}
      accessibilityLabel={
        active ? "Cancel download" : status === "ready" ? "Remove download" : "Download"
      }
    >
      {status === "downloading" ? (
        <DownloadProgressRing
          size={21}
          progress={progress ?? 0}
          color={MONO_ACTIVE}
          trackColor="rgba(255,255,255,0.18)"
        >
          {stopSquare}
        </DownloadProgressRing>
      ) : status === "queued" ? (
        <DownloadProgressRing
          size={21}
          color={MONO_ACTIVE}
          trackColor="rgba(255,255,255,0.18)"
        >
          {stopSquare}
        </DownloadProgressRing>
      ) : status === "ready" ? (
        <CheckCircle2 size={21} color={MONO_ACTIVE} />
      ) : status === "error" ? (
        <RefreshCw size={21} color={MONO_SECONDARY} />
      ) : (
        <CircleArrowDown size={21} color={MONO_IDLE} />
      )}
    </PlainIconButton>
  );
}

export function NowPlayingSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const song = usePlayerStore((state) => state.currentSong);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const smartShuffleEnabled = usePlayerStore((state) => state.smartShuffleEnabled);
  const repeatMode = usePlayerStore((state) => state.repeatMode);
  const playbackRate = usePlayerStore((state) => state.playbackRate);
  const toggle = usePlayerStore((state) => state.toggle);
  const next = usePlayerStore((state) => state.next);
  const previous = usePlayerStore((state) => state.previous);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((state) => state.cycleRepeatMode);
  const setPlaybackRate = usePlayerStore((state) => state.setPlaybackRate);
  const openQueue = useUiStore((state) => state.openQueue);
  const openSleepTimer = useUiStore((state) => state.openSleepTimer);
  const openListeningModes = useUiStore((state) => state.openListeningModes);
  const [showLyrics, setShowLyrics] = useState(false);

  const isRadio = isRadioSong(song);
  const isPodcast = isPodcastSong(song);
  const artSize = Math.min(width - 64, height * 0.39, 356);

  const swipe = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-12, 12])
    .onEnd((event) => {
      "worklet";
      if (event.translationX > 60) runOnJS(previous)();
      else if (event.translationX < -60) runOnJS(next)();
    });

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.94}>
      <View style={{ flex: 1, paddingHorizontal: 24, paddingBottom: insets.bottom + 20 }}>
        <View className="flex-row items-center justify-between py-2">
          <View style={{ width: 28 }} />
          <Text
            style={{
              color: MONO_SECONDARY,
              fontSize: 12,
              fontWeight: "600",
              letterSpacing: 1.2,
              textTransform: "uppercase",
            }}
          >
            {isRadio ? "Radio" : isPodcast ? "Podcast" : "Now Playing"}
          </Text>
          <View style={{ width: 28 }} />
        </View>

        {!song ? (
          <View className="flex-1 items-center justify-center">
            <Text style={{ color: MONO_SECONDARY }}>Nothing playing</Text>
          </View>
        ) : (
          <>
            {/* Plain secondary utilities live above the artwork, outside the cover. */}
            <View
              style={{
                height: 48,
                marginTop: 4,
                marginBottom: 6,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                alignSelf: "center",
                width: "100%",
                maxWidth: artSize,
                paddingHorizontal: 10,
              }}
            >
              <MonochromeDownloadButton song={song} />
              <MonochromeLikeButton song={song} />
              {song.lyricsUrl ? (
                <PlainIconButton
                  onPress={() => {
                    void selectionAsync();
                    setShowLyrics((value) => !value);
                  }}
                  selected={showLyrics}
                  accessibilityLabel={showLyrics ? "Hide lyrics" : "Show lyrics"}
                >
                  <MicVocal size={21} color={showLyrics ? MONO_ACTIVE : MONO_IDLE} />
                </PlainIconButton>
              ) : null}
              <PlainIconButton
                onPress={() => {
                  void selectionAsync();
                  openSleepTimer();
                }}
                accessibilityLabel="Sleep timer"
              >
                <Moon size={21} color={MONO_IDLE} />
              </PlainIconButton>
              <PlainIconButton
                onPress={() => {
                  void selectionAsync();
                  openQueue();
                }}
                accessibilityLabel="Queue"
              >
                <ListMusic size={21} color={MONO_IDLE} />
              </PlainIconButton>
            </View>

            {/* Artwork is the only expressive surface. Lyrics replace it in-place. */}
            <View className="flex-1 items-center justify-center">
              {showLyrics && song.lyricsUrl ? (
                <View style={{ width: "100%", flex: 1 }}>
                  <LyricsView song={song} />
                </View>
              ) : (
                <GestureDetector gesture={swipe}>
                  <Animated.View
                    entering={FadeIn.duration(520)}
                    style={{
                      width: artSize,
                      height: artSize,
                      borderRadius: 16,
                      borderCurve: "continuous",
                      backgroundColor: colors.surface,
                      shadowColor: "#000",
                      shadowOpacity: 0.24,
                      shadowRadius: 16,
                      shadowOffset: { width: 0, height: 10 },
                      elevation: 10,
                    }}
                  >
                    <View
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        borderRadius: 16,
                        borderCurve: "continuous",
                        borderWidth: 0.5,
                        borderColor: "rgba(255,255,255,0.08)",
                      }}
                    >
                      <CoverImage
                        src={song.imageUrl}
                        networkSrc={song.networkImageUrl}
                        style={{ width: "100%", height: "100%" }}
                        recyclingKey={song.id}
                      />
                    </View>
                  </Animated.View>
                </GestureDetector>
              )}
            </View>

            {/* Metadata */}
            <View className="mb-1 mt-4 flex-row items-end justify-between gap-3">
              <View className="min-w-0 flex-1">
                <MarqueeText
                  style={{ color: MONO_ACTIVE, fontSize: 23, lineHeight: 28, fontWeight: "600" }}
                >
                  {song.title}
                </MarqueeText>
                <Text
                  numberOfLines={1}
                  style={{ color: MONO_SECONDARY, fontSize: 15, marginTop: 2 }}
                >
                  {song.artist || "Unknown Artist"}
                </Text>
              </View>
              {isPodcast ? (
                <PressableScale
                  scaleTo={0.94}
                  onPress={() => setPlaybackRate(nextPlaybackRate(playbackRate))}
                  accessibilityRole="button"
                  accessibilityLabel={`Playback speed ${formatPlaybackRate(playbackRate)}`}
                  style={{
                    minWidth: 54,
                    height: 36,
                    paddingHorizontal: 12,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 18,
                    borderCurve: "continuous",
                    borderWidth: 0.5,
                    borderColor: MONO_HAIRLINE,
                  }}
                >
                  <Text style={{ color: MONO_ACTIVE, fontSize: 13, fontWeight: "600" }}>
                    {formatPlaybackRate(playbackRate)}
                  </Text>
                </PressableScale>
              ) : null}
            </View>

            {/* Scrubber */}
            <Scrubber live={isRadio} />

            {/* Transport */}
            <View className="mt-1 flex-row items-center justify-between">
              <PlainIconButton
                onPress={toggleShuffle}
                onLongPress={openListeningModes}
                selected={shuffle || smartShuffleEnabled}
                accessibilityLabel={smartShuffleEnabled ? "Smart Shuffle on" : "Toggle shuffle"}
                accessibilityHint="Long press for listening modes"
              >
                {smartShuffleEnabled ? (
                  <Sparkles size={22} color={MONO_ACTIVE} />
                ) : (
                  <Shuffle size={22} color={shuffle ? MONO_ACTIVE : MONO_IDLE} />
                )}
              </PlainIconButton>

              <View className="flex-row items-center" style={{ gap: 18 }}>
                <PlainIconButton onPress={previous} accessibilityLabel="Previous" size={48}>
                  <SkipBack size={27} color={MONO_ACTIVE} fill={MONO_ACTIVE} />
                </PlainIconButton>
                <PressableScale
                  scaleTo={0.94}
                  onPress={toggle}
                  accessibilityRole="button"
                  accessibilityLabel={isPlaying ? "Pause" : "Play"}
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 32,
                    borderCurve: "continuous",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "#fff",
                  }}
                >
                  {isPlaying ? (
                    <Pause size={26} color="#000" fill="#000" strokeWidth={0} />
                  ) : (
                    <Play
                      size={27}
                      color="#000"
                      fill="#000"
                      strokeWidth={0}
                      style={{ marginLeft: 3 }}
                    />
                  )}
                </PressableScale>
                <PlainIconButton onPress={next} accessibilityLabel="Next" size={48}>
                  <SkipForward size={27} color={MONO_ACTIVE} fill={MONO_ACTIVE} />
                </PlainIconButton>
              </View>

              <PlainIconButton
                onPress={cycleRepeatMode}
                selected={repeatMode !== "off"}
                accessibilityLabel={
                  repeatMode === "one"
                    ? "Repeat one"
                    : repeatMode === "all"
                      ? "Repeat all"
                      : "Repeat off"
                }
              >
                {repeatMode === "one" ? (
                  <Repeat1 size={22} color={MONO_ACTIVE} />
                ) : (
                  <Repeat size={22} color={repeatMode === "all" ? MONO_ACTIVE : MONO_IDLE} />
                )}
              </PlainIconButton>
            </View>

          </>
        )}
      </View>
    </Sheet>
  );
}
