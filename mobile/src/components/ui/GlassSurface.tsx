import { type ReactNode, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  type StyleProp,
  View,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { BlurView } from "expo-blur";
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
  type GlassColorScheme,
  type GlassStyle,
} from "expo-glass-effect";

type Props = Omit<ViewProps, "style"> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tintColor?: string;
  fallbackColor: string;
  blurIntensity?: number;
  glassStyle?: GlassStyle;
  colorScheme?: GlassColorScheme;
  interactive?: boolean;
};

function supportsLiquidGlass(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    return isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
  } catch {
    return false;
  }
}

// Expo SDK 57's native Liquid Glass surface on iOS 27, while retaining the
// existing blur/solid rendering on other platforms and when Reduce Transparency
// is enabled. Keep opacity off this component and its ancestors: native glass
// does not render correctly through an opacity animation.
export function GlassSurface({
  children,
  style,
  tintColor,
  fallbackColor,
  blurIntensity = 24,
  glassStyle = "regular",
  colorScheme = "dark",
  interactive = false,
  ...props
}: Props) {
  // Start conservatively so users with Reduce Transparency never see a one-frame
  // flash of glass before the async accessibility preference resolves.
  const [reduceTransparency, setReduceTransparency] = useState(true);

  useEffect(() => {
    void AccessibilityInfo.isReduceTransparencyEnabled().then(setReduceTransparency);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => subscription.remove();
  }, []);

  if (supportsLiquidGlass() && !reduceTransparency) {
    return (
      <GlassView
        {...props}
        colorScheme={colorScheme}
        glassEffectStyle={glassStyle}
        isInteractive={interactive}
        tintColor={tintColor}
        style={style}
      >
        {children}
      </GlassView>
    );
  }

  if (reduceTransparency) {
    return (
      <View {...props} style={[{ backgroundColor: fallbackColor }, style]}>
        {children}
      </View>
    );
  }

  return (
    <BlurView
      {...props}
      intensity={blurIntensity}
      tint="dark"
      style={[{ backgroundColor: fallbackColor }, style]}
    >
      {children}
    </BlurView>
  );
}
