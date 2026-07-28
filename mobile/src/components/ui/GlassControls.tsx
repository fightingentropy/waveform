import { type ReactNode } from "react";
import { Text, type ViewStyle } from "react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { colors } from "@/theme";

export function GlassIconButton({
  children,
  onPress,
  accessibilityLabel,
  size = 44,
  active = false,
}: {
  children: ReactNode;
  onPress: () => void;
  accessibilityLabel: string;
  size?: number;
  active?: boolean;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={accessibilityLabel}
      style={{
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </PressableScale>
  );
}

export function GlassChip({
  label,
  active = false,
  onPress,
  style,
}: {
  label: string;
  active?: boolean;
  onPress: () => void;
  style?: ViewStyle;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[
        {
          minHeight: 34,
          borderRadius: 17,
          borderCurve: "continuous",
          borderWidth: 0.5,
          borderColor: active ? "rgba(255,255,255,0.18)" : colors.line,
          backgroundColor: active ? colors.cardActive : colors.card,
          paddingHorizontal: 14,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <Text
        style={{
          color: active ? colors.foreground : colors.muted,
          fontSize: 13,
          fontWeight: active ? "600" : "500",
        }}
      >
        {label}
      </Text>
    </PressableScale>
  );
}
