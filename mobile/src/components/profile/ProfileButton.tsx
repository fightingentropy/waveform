import { View } from "react-native";
import { User } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { useAuth } from "@/lib/auth";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

// Top-left avatar. A quiet hairline keeps both photos and the neutral fallback
// legible without adding a second floating material around the control.
export function ProfileButton({ size = 40 }: { size?: number }) {
  const { user } = useAuth();
  const openProfileMenu = useUiStore((s) => s.openProfileMenu);

  return (
    <PressableScale
      onPress={openProfileMenu}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Open profile menu"
    >
      <View
        className="overflow-hidden rounded-full"
        style={{
          width: size,
          height: size,
          backgroundColor: colors.surface,
          borderWidth: 0.5,
          borderColor: colors.hairline,
        }}
      >
        {user?.image ? (
          <CoverImage src={user.image} style={{ width: "100%", height: "100%" }} />
        ) : (
          <View className="h-full w-full items-center justify-center">
            <User size={size * 0.56} color={colors.iconIdle} />
          </View>
        )}
      </View>
    </PressableScale>
  );
}
