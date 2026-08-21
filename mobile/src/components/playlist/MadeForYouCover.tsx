import { Disc3, Download, History, Sparkles, type LucideIcon } from "lucide-react-native";
import { Text, type StyleProp, View, type ViewStyle } from "react-native";
import {
  madeForYouDefinition,
  type MadeForYouKind,
} from "@/lib/made-for-you";

const ICONS: Record<MadeForYouKind, LucideIcon> = {
  daily: Sparkles,
  rediscover: History,
  offline: Download,
  "deep-cuts": Disc3,
};

export function MadeForYouCover({
  kind,
  style,
}: {
  kind: MadeForYouKind;
  style?: StyleProp<ViewStyle>;
}) {
  const definition = madeForYouDefinition(kind);
  const Icon = ICONS[kind];
  return (
    <View
      style={[
        {
          width: "100%",
          height: "100%",
          overflow: "hidden",
          backgroundColor: definition.background,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <View
        style={{
          position: "absolute",
          right: -34,
          top: -30,
          width: 124,
          height: 124,
          borderRadius: 62,
          backgroundColor: definition.glow,
          opacity: 0.72,
        }}
      />
      <View
        style={{
          position: "absolute",
          bottom: -44,
          left: -28,
          width: 118,
          height: 118,
          borderRadius: 59,
          backgroundColor: definition.accent,
          opacity: 0.16,
        }}
      />
      <Text
        style={{
          position: "absolute",
          left: 14,
          top: 13,
          color: definition.accent,
          fontSize: 10,
          fontWeight: "800",
          letterSpacing: 1.15,
        }}
      >
        FOR YOU
      </Text>
      <Icon size={51} color={definition.accent} strokeWidth={1.65} />
    </View>
  );
}
