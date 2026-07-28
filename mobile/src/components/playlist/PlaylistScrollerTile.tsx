import { Text, View } from "react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

// Home horizontal-scroller card for an auto-updating playlist (the Discover first
// row). Tapping opens the playlist detail (it navigates, never toggles audio).
// It shares the artwork-forward material treatment with ScrollerTile without
// creating a native GlassView for every repeated card.
export function PlaylistScrollerTile({
  name,
  subtitle,
  imageUrl,
  onPress,
}: {
  name: string;
  subtitle?: string;
  imageUrl?: string | null;
  onPress: () => void;
}) {
  return (
    <PressableScale
      scaleTo={0.985}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}`}
      style={{ width: 164 }}
    >
      <View
        style={{
          aspectRatio: 1,
          overflow: "hidden",
          borderRadius: 12,
          borderCurve: "continuous",
          backgroundColor: colors.card,
        }}
      >
        <CoverImage src={imageUrl} style={{ width: "100%", height: "100%" }} recyclingKey={imageUrl ?? name} />
      </View>
      <View style={{ minHeight: 48, paddingHorizontal: 1, paddingTop: 9 }}>
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
          {name}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={{ marginTop: 1, color: "rgba(255,255,255,0.58)", fontSize: 13.5, lineHeight: 19 }}>
            {subtitle}
          </Text>
        ) : null}
      </View>
    </PressableScale>
  );
}
