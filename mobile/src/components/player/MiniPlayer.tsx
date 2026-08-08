import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname } from "expo-router";
import { Heart, Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { MarqueeText } from "@/components/ui/MarqueeText";
import { GlassSurface } from "@/components/ui/GlassSurface";
import { useSongLike } from "@/components/song/useSongLike";
import { useAudioProgress } from "@/audio/progress";
import { selectionAsync } from "@/lib/haptics";
import { colors, layout } from "@/theme";
import { usePlayerStore } from "@/store/player";
import { useUiStore } from "@/store/ui";
import type { PlayerSong } from "@/types/player";

function MiniPlayerLikeButton({ song }: { song: PlayerSong }) {
  const { liked, pending, canLike, toggle } = useSongLike(song);
  if (!canLike) return null;

  return (
    <PressableScale
      onPress={() => {
        void selectionAsync();
        toggle();
      }}
      disabled={pending}
      accessibilityRole="button"
      accessibilityState={{ selected: liked, disabled: pending }}
      accessibilityLabel={liked ? `Remove ${song.title} from Liked Songs` : `Save ${song.title} to Liked Songs`}
      style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
    >
      <View style={{ opacity: pending ? 0.6 : 1 }}>
        <Heart
          size={22}
          color={colors.foreground}
          fill={liked ? colors.foreground : "transparent"}
        />
      </View>
    </PressableScale>
  );
}

// Keep the native playback clock's 4 Hz updates inside the two-pixel progress
// strip. If MiniPlayer owns this subscription, every tick reconciles the glass
// surface, artwork, marquee, heart, and transport even though none changed.
function MiniPlayerProgress() {
  const { position, duration } = useAudioProgress();
  const progress = duration > 0 ? Math.max(0, Math.min(1, position / duration)) : 0;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 2,
        backgroundColor: "rgba(255,255,255,0.12)",
      }}
    >
      <View
        style={{
          width: `${progress * 100}%`,
          height: "100%",
          backgroundColor: "rgba(255,255,255,0.82)",
        }}
      />
    </View>
  );
}

// The persistent mini-player bar: cover + title/artist + heart + play/pause; tapping
// it (anywhere but the controls) opens the Now Playing sheet. Mounted once at the
// root so it stays visible on every screen, not just the tabs.
export function MiniPlayer() {
  const song = usePlayerStore((s) => s.currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);
  const openNowPlaying = useUiStore((s) => s.openNowPlaying);
  const insets = useSafeAreaInsets();
  const pathname = usePathname();

  if (!song || pathname === "/signin" || pathname === "/register") return null;

  // The tab bar is mounted globally on every screen, so the bar always sits above it.
  const bottom =
    insets.bottom +
    layout.mobileNavHeight +
    layout.floatingGap;

  return (
    <GlassSurface
      tintColor="rgba(12,14,18,0.60)"
      fallbackColor="rgba(10,12,16,0.84)"
      blurIntensity={44}
      style={{
        position: "absolute",
        left: layout.floatingInset,
        right: layout.floatingInset,
        bottom,
        height: layout.mobilePlayerHeight,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 10,
        borderRadius: 18,
        borderCurve: "continuous",
        overflow: "hidden",
        borderWidth: 0.5,
        borderColor: "rgba(255,255,255,0.13)",
        shadowColor: "#000",
        shadowOpacity: 0.2,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 8 },
        zIndex: 91,
      }}
    >
      <PressableScale
        scaleTo={1}
        onPress={openNowPlaying}
        accessibilityRole="button"
        accessibilityLabel={`Open now playing: ${song.title}`}
        className="min-w-0 flex-1 flex-row items-center gap-3"
      >
        <View
          style={{
            width: 50,
            height: 50,
            borderRadius: 9,
            borderCurve: "continuous",
            overflow: "hidden",
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
          <MarqueeText className="text-sm font-medium text-foreground">{song.title}</MarqueeText>
          <Text numberOfLines={1} className="text-xs" style={{ color: colors.muted }}>
            {song.artist || "Unknown Artist"}
          </Text>
        </View>
      </PressableScale>
      <MiniPlayerLikeButton song={song} />
      <PressableScale
        onPress={toggle}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={isPlaying ? "Pause" : "Play"}
        style={{
          width: 44,
          height: 44,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <View>
          {isPlaying ? (
            <Pause size={26} color={colors.foreground} fill={colors.foreground} />
          ) : (
            <Play size={26} color={colors.foreground} fill={colors.foreground} />
          )}
        </View>
      </PressableScale>
      <MiniPlayerProgress />
    </GlassSurface>
  );
}
