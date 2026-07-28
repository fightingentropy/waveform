import { type ReactNode, useCallback, useEffect, useState } from "react";
import { BackHandler, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { colors, motion } from "@/theme";

const DRAG_CLOSE_THRESHOLD = 120;
const SHEET_RADIUS = 28;

// Reusable controlled bottom sheet. Renders nothing while closed; on `visible` it
// mounts a z-indexed, full-screen absolute overlay (rendered in PlayerSheets at the
// root, above the navigator) with a tap-to-close backdrop that fades in and a
// bottom-pinned panel that slides up. On `visible=false` it plays the exit
// animation, then unmounts. Pan the panel down past ~120px to close.
//
// NOT an RN <Modal>: a second Modal can't reliably present over an already-open
// Modal on iOS, which broke opening the Queue / Sleep-timer sheets from within the
// Now Playing sheet. An absolute overlay stacks correctly via `zIndex` — sub-sheets
// pass a higher zIndex so they sit above the sheet that opened them.
export function Sheet({
  visible,
  onClose,
  heightPct = 0.94,
  zIndex = 100,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  heightPct?: number;
  zIndex?: number;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height: screenH } = useWindowDimensions();

  // Keep the panel mounted through the exit animation, then unmount.
  const [mounted, setMounted] = useState(visible);

  // Panel height: requested fraction of the screen, but never under the notch.
  const maxH = screenH - insets.top;
  const panelH = Math.min(screenH * heightPct, maxH);

  const progress = useSharedValue(0); // 0 = hidden, 1 = shown
  const dragY = useSharedValue(0); // live finger offset while dragging down

  const unmount = useCallback(() => setMounted(false), []);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      dragY.value = 0;
      progress.value = withTiming(1, {
        duration: motion.npOpen.ms,
        easing: Easing.bezier(...motion.npOpen.bezier),
      });
    } else if (mounted) {
      progress.value = withTiming(
        0,
        { duration: motion.npClose.ms, easing: Easing.bezier(...motion.npClose.bezier) },
        (finished) => {
          "worklet";
          if (finished) runOnJS(unmount)();
        },
      );
    }
  }, [visible, mounted, progress, dragY, unmount]);

  useEffect(() => {
    if (!mounted || !visible) return undefined;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [mounted, onClose, visible]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  const panelStyle = useAnimatedStyle(() => {
    // Slide the full panel height when hidden; add the live drag offset.
    const base = panelH * (1 - progress.value);
    return { transform: [{ translateY: base + dragY.value }] };
  });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      "worklet";
      dragY.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      "worklet";
      if (e.translationY > DRAG_CLOSE_THRESHOLD || e.velocityY > 800) {
        runOnJS(onClose)();
      } else {
        dragY.value = withTiming(0, { duration: 180, easing: Easing.out(Easing.quad) });
      }
    });

  if (!mounted) return null;

  return (
    // Safety net: the overlay only swallows touches while actually open. The moment
    // `visible` is false we set pointerEvents="none" so the (now transparent,
    // off-screen) layer lets every touch through to the app underneath — even if the
    // exit animation is interrupted and the `finished`-gated unmount below never
    // fires. Without this, an interrupted close left an invisible full-screen layer
    // that froze every control (you could still hear audio but couldn't tap anything).
    <View
      pointerEvents={visible ? "auto" : "none"}
      accessibilityViewIsModal={visible}
      importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
      onAccessibilityEscape={onClose}
      style={[StyleSheet.absoluteFill, { zIndex, elevation: zIndex, justifyContent: "flex-end" }]}
    >
      {/* backdrop: tap to close. A real Pressable (not raw onTouchEnd, which fired for
          any stray touch ending here — including the tail of the gesture that opened
          the sheet, dismissing it the instant it appeared). */}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.backdrop }, backdropStyle]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      </Animated.View>

      {/* panel */}
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            {
              height: panelH,
              borderTopLeftRadius: SHEET_RADIUS,
              borderTopRightRadius: SHEET_RADIUS,
              borderCurve: "continuous",
              shadowColor: "#000",
              shadowOpacity: 0.22,
              shadowRadius: 16,
              shadowOffset: { width: 0, height: -5 },
              elevation: 16,
            },
            panelStyle,
          ]}
        >
          <View
            style={{
              flex: 1,
              overflow: "hidden",
              backgroundColor: colors.surface,
              borderTopLeftRadius: SHEET_RADIUS,
              borderTopRightRadius: SHEET_RADIUS,
              borderCurve: "continuous",
              borderWidth: 0.5,
              borderColor: colors.hairline,
            }}
          >
            {/* grab handle */}
            <View style={{ alignItems: "center", paddingTop: 11, paddingBottom: 5 }}>
              <View
                style={{
                  width: 36,
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: "rgba(255,255,255,0.28)",
                }}
              />
            </View>
            <View style={{ flex: 1 }}>{children}</View>
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
