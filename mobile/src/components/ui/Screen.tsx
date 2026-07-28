import { type ReactNode } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AmbientBackdrop } from "@/components/ui/AmbientBackdrop";
import { colors, layout } from "@/theme";

// Bottom space reserved on tab screens for the mini-player + tab bar + safe area.
export const CONTENT_BOTTOM_INSET =
  layout.mobileNavHeight +
  layout.mobilePlayerHeight +
  layout.floatingGap +
  layout.floatingInset +
  36;

export function Screen({
  children,
  topInset = true,
  ambience = "default",
}: {
  children: ReactNode;
  topInset?: boolean;
  ambience?: "default" | "auth" | "player" | "none";
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: topInset ? insets.top : 0 }}>
      {ambience === "none" ? null : <AmbientBackdrop variant={ambience} />}
      {children}
    </View>
  );
}
