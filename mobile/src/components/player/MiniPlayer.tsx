import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { MarqueeText } from "@/components/ui/MarqueeText";
import { HeartButton } from "@/components/song/HeartButton";
import { useArtworkColor } from "@/lib/useArtworkColor";
import { colors, layout } from "@/theme";
import { usePlayerStore } from "@/store/player";
import { useUiStore } from "@/store/ui";

// The persistent mini-player bar: cover + title/artist + heart + play/pause; tapping
// it (anywhere but the controls) opens the Now Playing sheet. Mounted once at the
// root so it stays visible on every screen, not just the tabs.
export function MiniPlayer() {
  const song = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);
  const openNowPlaying = useUiStore((s) => s.openNowPlaying);
  const insets = useSafeAreaInsets();
  // Spotify-style: tint the bar with a representative color from the cover — same
  // source as the Now Playing background, so the two stay in sync.
  const tint = useArtworkColor(song?.imageUrl ?? song?.networkImageUrl);

  if (!song) return null;

  // The tab bar is mounted globally on every screen, so the bar always sits above it.
  const bottom = layout.mobileNavHeight + insets.bottom;

  return (
    <View
      className="flex-row items-center gap-3 px-3"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom,
        height: layout.mobilePlayerHeight,
        backgroundColor: tint ?? colors.surface,
        overflow: "hidden",
      }}
    >
      <PressableScale
        scaleTo={1}
        onPress={openNowPlaying}
        accessibilityRole="button"
        accessibilityLabel={`Open now playing: ${song.title}`}
        className="min-w-0 flex-1 flex-row items-center gap-3"
      >
        <View className="h-11 w-11 overflow-hidden rounded">
          <CoverImage src={song.imageUrl} networkSrc={song.networkImageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={song.id} />
        </View>
        <View className="min-w-0 flex-1">
          <MarqueeText className="text-sm font-medium text-foreground">{song.title}</MarqueeText>
          <Text numberOfLines={1} className="text-xs" style={{ color: colors.muted }}>
            {song.artist || "Unknown Artist"}
          </Text>
        </View>
      </PressableScale>
      <HeartButton song={song} size={22} />
      <PressableScale
        onPress={toggle}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? "Pause" : "Play"}
        className="h-10 w-10 items-center justify-center"
      >
        <View>
          {isPlaying ? (
            <Pause size={26} color={colors.foreground} fill={colors.foreground} />
          ) : (
            <Play size={26} color={colors.foreground} fill={colors.foreground} />
          )}
        </View>
      </PressableScale>
    </View>
  );
}
