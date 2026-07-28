import { ActivityIndicator, Text, View } from "react-native";
import { Pause, Play } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { GlassSurface } from "@/components/ui/GlassSurface";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

// Artwork-forward Home tile. The card itself stays a lightweight translucent
// material; native glass is reserved for the single active transport control.
export function ScrollerTile({
  title,
  artist,
  imageUrl,
  networkImageUrl,
  subtitle,
  active,
  isPlaying,
  loading,
  onPress,
}: {
  title: string;
  artist: string;
  imageUrl?: string | null;
  networkImageUrl?: string | null;
  subtitle?: string;
  active: boolean;
  isPlaying: boolean;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      scaleTo={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={active && isPlaying ? `Pause ${title}` : `Play ${title}`}
      accessibilityState={{ selected: active }}
      style={{ width: 164 }}
    >
      <View
        style={{
          aspectRatio: 1,
          overflow: "hidden",
          borderRadius: 12,
          borderCurve: "continuous",
          backgroundColor: colors.card,
          borderWidth: active ? 1 : 0,
          borderColor: "rgba(255,255,255,0.30)",
        }}
      >
        <CoverImage
          src={imageUrl}
          networkSrc={networkImageUrl}
          style={{ width: "100%", height: "100%" }}
          recyclingKey={imageUrl ?? title}
        />
        {loading ? (
          <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: "rgba(0,0,0,0.55)" }}>
            <ActivityIndicator color="#fff" />
          </View>
        ) : null}
        {active ? (
          <GlassSurface
            pointerEvents="none"
            glassStyle="clear"
            tintColor="rgba(6,8,12,0.42)"
            fallbackColor="rgba(8,10,14,0.76)"
            style={{
              position: "absolute",
              right: 10,
              bottom: 10,
              width: 42,
              height: 42,
              borderRadius: 21,
              borderCurve: "continuous",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              borderWidth: 0.5,
              borderColor: "rgba(255,255,255,0.26)",
            }}
          >
            {isPlaying ? (
              <Pause size={20} color="#fff" fill="#fff" strokeWidth={0} />
            ) : (
              <Play size={20} color="#fff" fill="#fff" strokeWidth={0} style={{ marginLeft: 2 }} />
            )}
          </GlassSurface>
        ) : null}
      </View>
      <View style={{ minHeight: subtitle ? 65 : 48, paddingHorizontal: 1, paddingTop: 9 }}>
        <Text
          numberOfLines={1}
          style={{
            color: colors.foreground,
            fontSize: 15.5,
            fontWeight: "700",
            lineHeight: 21,
            letterSpacing: -0.15,
          }}
        >
          {title}
        </Text>
        <Text numberOfLines={1} style={{ marginTop: 1, color: "rgba(255,255,255,0.62)", fontSize: 13.5, lineHeight: 19 }}>
          {artist || "Unknown Artist"}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={{ marginTop: 2, color: colors.dim, fontSize: 12.5, lineHeight: 17 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}
