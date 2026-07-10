import { useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { FadeIn, runOnJS } from "react-native-reanimated";
import { ListMusic, MicVocal, Moon, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Sparkles } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { MarqueeText } from "@/components/ui/MarqueeText";
import { Sheet } from "@/components/ui/Sheet";
import { Scrubber } from "@/components/player/Scrubber";
import { LyricsView } from "@/components/player/LyricsView";
import { HeartButton } from "@/components/song/HeartButton";
import { DownloadButton } from "@/components/song/DownloadButton";
import { colors } from "@/theme";
import { isRadioSong, isPodcastSong } from "@/lib/player-song";
import { useArtworkColor } from "@/lib/useArtworkColor";
import { formatPlaybackRate, nextPlaybackRate, usePlayerStore } from "@/store/player";
import { useUiStore } from "@/store/ui";

export function NowPlayingSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const song = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const smartShuffleEnabled = usePlayerStore((s) => s.smartShuffleEnabled);
  const repeatMode = usePlayerStore((s) => s.repeatMode);
  const playbackRate = usePlayerStore((s) => s.playbackRate);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeatMode = usePlayerStore((s) => s.cycleRepeatMode);
  const setPlaybackRate = usePlayerStore((s) => s.setPlaybackRate);
  const openQueue = useUiStore((s) => s.openQueue);
  const openSleepTimer = useUiStore((s) => s.openSleepTimer);
  const openListeningModes = useUiStore((s) => s.openListeningModes);
  const [showLyrics, setShowLyrics] = useState(false);

  const isRadio = isRadioSong(song);
  const isPodcast = isPodcastSong(song);
  const artSize = Math.min(width - 48, 380);
  // Spotify-style: tint the background with a representative color from the cover.
  const tint = useArtworkColor(song?.imageUrl ?? song?.networkImageUrl);

  // Swipe the artwork left/right to change track (horizontal only; a clear
  // horizontal swipe wins over the sheet's pan-down-to-close).
  const swipe = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-12, 12])
    .onEnd((e) => {
      "worklet";
      if (e.translationX > 60) runOnJS(previous)();
      else if (e.translationX < -60) runOnJS(next)();
    });

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      heightPct={0.94}
      backgroundGradient={tint ? [tint, tint, colors.background] : undefined}
    >
      <View style={{ flex: 1, paddingHorizontal: 24, paddingBottom: insets.bottom + 32 }}>
        {/* header — no close chevron; the grab handle + swipe-down (and the
            backdrop tap) dismiss the sheet. Spacers keep the label centered. */}
        <View className="flex-row items-center justify-between py-2">
          <View style={{ width: 28 }} />
          <Text className="text-xs font-semibold uppercase tracking-widest" style={{ color: colors.muted }}>
            {isRadio ? "Radio" : isPodcast ? "Podcast" : "Now Playing"}
          </Text>
          <View style={{ width: 28 }} />
        </View>

        {!song ? (
          <View className="flex-1 items-center justify-center">
            <Text style={{ color: colors.muted }}>Nothing playing</Text>
          </View>
        ) : (
          <>
            {/* top action toolbar: download / like / lyrics / sleep / queue */}
            <View className="mb-3 flex-row items-center justify-between px-1">
              <DownloadButton song={song} size={22} />
              <HeartButton song={song} size={24} />
              {/* Lyrics toggle — only shown when the song actually has lyrics. */}
              {song.lyricsUrl ? (
                <PressableScale onPress={() => setShowLyrics((v) => !v)} hitSlop={8} accessibilityLabel="Toggle lyrics">
                  <View>
                    <MicVocal size={22} color={showLyrics ? colors.emerald : colors.iconIdle} />
                  </View>
                </PressableScale>
              ) : null}
              <PressableScale onPress={openSleepTimer} hitSlop={8} accessibilityLabel="Sleep timer">
                <View>
                  <Moon size={22} color={colors.iconIdle} />
                </View>
              </PressableScale>
              <PressableScale onPress={openQueue} hitSlop={8} accessibilityLabel="Queue">
                <View>
                  <ListMusic size={22} color={colors.iconIdle} />
                </View>
              </PressableScale>
            </View>

            {/* art / lyrics */}
            <View className="flex-1 items-center justify-center">
              {showLyrics && song.lyricsUrl ? (
                <View style={{ width: "100%", flex: 1 }}>
                  <LyricsView song={song} />
                </View>
              ) : (
                <GestureDetector gesture={swipe}>
                  <Animated.View entering={FadeIn.duration(520)} style={{ width: artSize, height: artSize }}>
                    <CoverImage
                      src={song.imageUrl}
                      networkSrc={song.networkImageUrl}
                      style={{ width: "100%", height: "100%", borderRadius: 16 }}
                      recyclingKey={song.id}
                    />
                  </Animated.View>
                </GestureDetector>
              )}
            </View>

            {/* title + artist + speed chip */}
            <View className="mb-2 flex-row items-end justify-between gap-3">
              <View className="min-w-0 flex-1">
                <MarqueeText className="text-2xl font-bold text-foreground">{song.title}</MarqueeText>
                <Text numberOfLines={1} className="mt-1 text-base" style={{ color: colors.muted }}>
                  {song.artist || "Unknown Artist"}
                </Text>
              </View>
              {isPodcast ? (
                <PressableScale
                  onPress={() => setPlaybackRate(nextPlaybackRate(playbackRate))}
                  className="rounded-full border px-3 py-1.5"
                  style={{ borderColor: colors.line }}
                >
                  <Text className="text-sm font-semibold" style={{ color: colors.emerald }}>
                    {formatPlaybackRate(playbackRate)}
                  </Text>
                </PressableScale>
              ) : null}
            </View>

            {/* scrubber */}
            <Scrubber live={isRadio} />

            {/* transport: shuffle / [gap] prev / play / next [gap] / repeat */}
            <View className="mt-3 flex-row items-center justify-between">
              {/* Single tap = plain shuffle toggle; long-press opens the listening
                  modes sheet (Off / Shuffle / Smart Shuffle). When Smart Shuffle is
                  on, swap the glyph for an emerald Sparkles so the active mode reads
                  at a glance. */}
              <PressableScale
                onPress={toggleShuffle}
                onLongPress={() => openListeningModes()}
                hitSlop={10}
                accessibilityLabel={smartShuffleEnabled ? "Smart Shuffle on" : "Toggle shuffle"}
              >
                <View style={{ alignItems: "center", justifyContent: "center" }}>
                  {smartShuffleEnabled ? (
                    <Sparkles size={24} color={colors.emerald} />
                  ) : (
                    <Shuffle size={24} color={shuffle ? colors.emerald : colors.iconIdle} />
                  )}
                  {/* active-mode dot — mirrors Spotify's small marker under the control */}
                  {(shuffle || smartShuffleEnabled) ? (
                    <View
                      style={{
                        marginTop: 4,
                        width: 4,
                        height: 4,
                        borderRadius: 2,
                        backgroundColor: colors.emerald,
                      }}
                    />
                  ) : null}
                </View>
              </PressableScale>

              {/* grouped prev/play/next with a real gap so a Next tap can't hit play/pause */}
              <View className="flex-row items-center" style={{ gap: 28 }}>
                <PressableScale onPress={previous} hitSlop={8} accessibilityLabel="Previous">
                  <View>
                    <SkipBack size={32} color={colors.foreground} fill={colors.foreground} />
                  </View>
                </PressableScale>
                <PressableScale onPress={toggle} accessibilityLabel={isPlaying ? "Pause" : "Play"}>
                  <View className="h-16 w-16 items-center justify-center rounded-full" style={{ backgroundColor: "#fff" }}>
                    {isPlaying ? (
                      <Pause size={26} color="#000" fill="#000" strokeWidth={0} />
                    ) : (
                      <Play size={26} color="#000" fill="#000" strokeWidth={0} style={{ marginLeft: 2 }} />
                    )}
                  </View>
                </PressableScale>
                <PressableScale onPress={next} hitSlop={8} accessibilityLabel="Next">
                  <View>
                    <SkipForward size={32} color={colors.foreground} fill={colors.foreground} />
                  </View>
                </PressableScale>
              </View>

              <PressableScale onPress={cycleRepeatMode} hitSlop={10} accessibilityLabel="Cycle repeat mode">
                <View>
                  {repeatMode === "one" ? (
                    <Repeat1 size={24} color={colors.emerald} />
                  ) : (
                    <Repeat size={24} color={repeatMode === "all" ? colors.emerald : colors.iconIdle} />
                  )}
                </View>
              </PressableScale>
            </View>
          </>
        )}
      </View>
    </Sheet>
  );
}
