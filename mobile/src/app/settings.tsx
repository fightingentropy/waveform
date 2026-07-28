import { ScrollView, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Constants from "expo-constants";
import { ArrowDownToLine, ChevronRight, Info, Languages, Plus, User, Volume2 } from "lucide-react-native";
import { CONTENT_BOTTOM_INSET, Screen } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { useAuth } from "@/lib/auth";
import { usePrefsStore } from "@/store/prefs";
import { colors } from "@/theme";

const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";

// One Spotify-style menu row: leading icon, title + subtitle, trailing chevron.
function SettingsRow({
  Icon,
  title,
  subtitle,
  onPress,
}: {
  Icon: typeof User;
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <PressableScale scaleTo={1} onPress={onPress} className="flex-row items-center gap-4 px-4 py-3.5">
      <Icon size={24} color={colors.foreground} />
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] font-semibold" style={{ color: colors.foreground }}>
          {title}
        </Text>
        <Text numberOfLines={1} className="mt-0.5 text-[13px]" style={{ color: colors.muted }}>
          {subtitle}
        </Text>
      </View>
      <ChevronRight size={20} color={colors.muted} />
    </PressableScale>
  );
}

// Same row layout, but trailing Switch instead of a chevron (no navigation).
function SettingsToggleRow({
  Icon,
  title,
  subtitle,
  value,
  onValueChange,
}: {
  Icon: typeof User;
  title: string;
  subtitle: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  return (
    <View className="flex-row items-center gap-4 px-4 py-3.5">
      <Icon size={24} color={colors.foreground} />
      <View className="min-w-0 flex-1">
        <Text className="text-[17px] font-semibold" style={{ color: colors.foreground }}>
          {title}
        </Text>
        <Text numberOfLines={1} className="mt-0.5 text-[13px]" style={{ color: colors.muted }}>
          {subtitle}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: "rgba(255,255,255,0.42)", false: "#3a3a3a" }}
        thumbColor="#fff"
      />
    </View>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const showCreateTab = usePrefsStore((s) => s.showCreateTab);
  const setShowCreateTab = usePrefsStore((s) => s.setShowCreateTab);

  return (
    <Screen topInset={false}>
      <ScrollView contentContainerStyle={{ paddingTop: 6, paddingBottom: CONTENT_BOTTOM_INSET }}>
        <SettingsRow
          Icon={User}
          title="Account"
          subtitle={user?.email ?? "Manage your account"}
          onPress={() => router.push("/settings/account")}
        />
        <SettingsRow Icon={Volume2} title="Playback" subtitle="Crossfade" onPress={() => router.push("/settings/playback")} />
        <SettingsRow
          Icon={Languages}
          title="Lyrics"
          subtitle="Greek pronunciation"
          onPress={() => router.push("/settings/lyrics")}
        />
        <SettingsRow
          Icon={ArrowDownToLine}
          title="Data-saving and offline"
          subtitle="Downloads • Offline"
          onPress={() => router.push("/settings/storage")}
        />
        <SettingsRow Icon={Info} title="About" subtitle={`Version ${APP_VERSION}`} onPress={() => router.push("/settings/about")} />

        <SettingsToggleRow
          Icon={Plus}
          title="Create button"
          subtitle="Show the + in the bottom navigation bar"
          value={showCreateTab}
          onValueChange={setShowCreateTab}
        />

        <View className="mt-10 items-center">
          <PressableScale
            onPress={() => void signOut()}
            className="rounded-full px-12 py-3"
            style={{ backgroundColor: "#fff" }}
            accessibilityRole="button"
            accessibilityLabel="Log out"
          >
            <Text className="text-base font-bold" style={{ color: "#000" }}>
              Log out
            </Text>
          </PressableScale>
        </View>
      </ScrollView>
    </Screen>
  );
}
