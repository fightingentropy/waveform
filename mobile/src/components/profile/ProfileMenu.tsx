import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useRouter } from "expo-router";
import { BarChart3, LogOut, Settings, User } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { useAuth } from "@/lib/auth";
import { useUiStore } from "@/store/ui";
import { colors, motion } from "@/theme";

function MenuItem({ icon, label, onPress }: { icon: ReactNode; label: string; onPress: () => void }) {
  return (
    <PressableScale scaleTo={1} onPress={onPress} className="flex-row items-center gap-4 px-5 py-3.5">
      {icon}
      <Text className="text-base" style={{ color: colors.foreground }}>
        {label}
      </Text>
    </PressableScale>
  );
}

// Right slide-in profile drawer (Spotify-style), opened by the header avatar
// (ProfileButton). Mounted once at the root so it overlays every screen. Mirrors the
// Sheet pattern (mounted-through-exit, progress sharedValue) but slides horizontally;
// swipe right or tap the backdrop to close.
export function ProfileMenu() {
  const open = useUiStore((s) => s.profileMenuOpen);
  const close = useUiStore((s) => s.closeProfileMenu);
  const { user, signOut } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelW = Math.min(width * 0.82, 360);

  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(0);
  const dragX = useSharedValue(0);
  const unmount = useCallback(() => setMounted(false), []);

  useEffect(() => {
    if (open) {
      setMounted(true);
      dragX.value = 0;
      progress.value = withTiming(1, { duration: motion.npOpen.ms, easing: Easing.bezier(...motion.npOpen.bezier) });
    } else if (mounted) {
      progress.value = withTiming(0, { duration: motion.npClose.ms, easing: Easing.bezier(...motion.npClose.bezier) }, (f) => {
        "worklet";
        if (f) runOnJS(unmount)();
      });
    }
  }, [open, mounted, progress, dragX, unmount]);

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0, progress.value - dragX.value / panelW),
  }));
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: panelW * (1 - progress.value) + dragX.value }],
  }));

  const pan = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .onUpdate((e) => {
      "worklet";
      dragX.value = Math.max(0, e.translationX);
    })
    .onEnd((e) => {
      "worklet";
      if (e.translationX > 80 || e.velocityX > 800) {
        runOnJS(close)();
      } else {
        dragX.value = withTiming(0, { duration: 180, easing: Easing.out(Easing.quad) });
      }
    });

  const goProfile = useCallback(() => {
    close();
    router.push("/profile");
  }, [close, router]);
  const goStats = useCallback(() => {
    close();
    router.push("/listening-stats");
  }, [close, router]);
  const goSettings = useCallback(() => {
    close();
    router.push("/settings");
  }, [close, router]);
  const doLogout = useCallback(() => {
    close();
    void signOut();
  }, [close, signOut]);

  if (!mounted) return null;

  return (
    <View
      pointerEvents={open ? "auto" : "none"}
      accessibilityViewIsModal={open}
      importantForAccessibility={open ? "yes" : "no-hide-descendants"}
      onAccessibilityEscape={close}
      style={[StyleSheet.absoluteFill, { zIndex: 120, elevation: 120 }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }, backdropStyle]}>
        <Pressable style={{ flex: 1 }} onPress={close} accessibilityRole="button" accessibilityLabel="Close menu" />
      </Animated.View>

      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            {
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: panelW,
              backgroundColor: colors.surface,
              paddingTop: insets.top + 12,
              paddingBottom: insets.bottom + 12,
            },
            panelStyle,
          ]}
        >
          <PressableScale scaleTo={1} onPress={goProfile} className="flex-row items-center gap-3 px-5 py-3">
            <View className="h-14 w-14 overflow-hidden rounded-full" style={{ backgroundColor: "#333" }}>
              {user?.image ? (
                <CoverImage src={user.image} style={{ width: "100%", height: "100%" }} />
              ) : (
                <View className="h-full w-full items-center justify-center">
                  <User size={26} color={colors.iconIdle} />
                </View>
              )}
            </View>
            <View className="min-w-0 flex-1">
              <Text numberOfLines={1} className="text-xl font-bold" style={{ color: colors.foreground }}>
                {user?.name || user?.email || "You"}
              </Text>
              <Text className="text-sm" style={{ color: colors.muted }}>
                View profile
              </Text>
            </View>
          </PressableScale>

          <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 8, marginHorizontal: 20 }} />

          <MenuItem icon={<BarChart3 size={22} color={colors.foreground} />} label="Listening stats" onPress={goStats} />
          <MenuItem icon={<Settings size={22} color={colors.foreground} />} label="Settings and privacy" onPress={goSettings} />

          <View style={{ flex: 1 }} />

          <View style={{ height: 1, backgroundColor: colors.line, marginVertical: 8, marginHorizontal: 20 }} />
          <MenuItem icon={<LogOut size={22} color={colors.foreground} />} label="Log out" onPress={doLogout} />
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
