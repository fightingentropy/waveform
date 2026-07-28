import { ScrollView, Text, View } from "react-native";
import Constants from "expo-constants";
import { CONTENT_BOTTOM_INSET, Screen } from "@/components/ui/Screen";
import { colors } from "@/theme";

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between px-4 py-3.5">
      <Text className="text-[15px]" style={{ color: colors.foreground }}>
        {label}
      </Text>
      <Text className="text-[15px]" style={{ color: colors.muted }}>
        {value}
      </Text>
    </View>
  );
}

export default function AboutSettingsScreen() {
  const version = Constants.expoConfig?.version ?? "1.0.0";

  return (
    <Screen topInset={false}>
      <ScrollView contentContainerStyle={{ paddingTop: 12, paddingBottom: CONTENT_BOTTOM_INSET }}>
        <AboutRow label="App" value={Constants.expoConfig?.name ?? "Spotify"} />
        <View style={{ height: 1, backgroundColor: colors.line, marginHorizontal: 16 }} />
        <AboutRow label="Version" value={version} />
      </ScrollView>
    </Screen>
  );
}
