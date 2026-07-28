import { StyleSheet, View } from "react-native";

type Variant = "default" | "auth" | "player";

const flatBackgrounds: Record<Variant, string> = {
  default: "#000000",
  auth: "#020202",
  player: "#000000",
} as const;

// Keep the canvas deliberately quiet. Depth comes from native material surfaces,
// hairlines, and content—not decorative color fields.
export function AmbientBackdrop({ variant = "default" }: { variant?: Variant }) {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: flatBackgrounds[variant] }]}
    />
  );
}
