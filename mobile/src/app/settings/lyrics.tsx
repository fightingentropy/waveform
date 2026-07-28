import { ScrollView, Switch, Text, View } from "react-native";
import { CONTENT_BOTTOM_INSET, Screen } from "@/components/ui/Screen";
import { usePreferencesStore } from "@/store/preferences";
import { colors } from "@/theme";

export default function LyricsSettingsScreen() {
  const greekPhonetics = usePreferencesStore((s) => s.greekPhonetics);
  const setGreekPhonetics = usePreferencesStore((s) => s.setGreekPhonetics);

  return (
    <Screen topInset={false}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: CONTENT_BOTTOM_INSET,
        }}
      >
        <Text className="mb-5 text-2xl font-bold" style={{ color: colors.foreground }}>
          Pronunciation
        </Text>

        <View className="flex-row items-start justify-between">
          <View className="mr-4 flex-1">
            <Text className="text-[17px] font-semibold" style={{ color: colors.foreground }}>
              Greek pronunciation
            </Text>
            <Text className="mt-1 text-[13px] leading-5" style={{ color: colors.muted }}>
              Show a phonetic spelling under each Greek lyric line, so you can read along even if you don't read
              Greek.
            </Text>
          </View>
          <Switch
            value={greekPhonetics}
            onValueChange={setGreekPhonetics}
            trackColor={{ true: "rgba(255,255,255,0.42)", false: "#3a3a3a" }}
            thumbColor="#fff"
          />
        </View>

        {greekPhonetics ? (
          <View className="mt-6 rounded-xl p-4" style={{ backgroundColor: colors.card }}>
            <Text className="text-[15px] font-semibold leading-6" style={{ color: colors.foreground }}>
              Σ' αγαπώ
            </Text>
            <Text className="mt-0.5 text-[13px] italic leading-5" style={{ color: colors.muted }}>
              S' agapó
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
