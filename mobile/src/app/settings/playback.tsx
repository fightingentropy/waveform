import { ScrollView, Switch, Text, View } from "react-native";
import Slider from "@react-native-community/slider";
import { CONTENT_BOTTOM_INSET, Screen } from "@/components/ui/Screen";
import { usePlayerStore } from "@/store/player";
import { colors } from "@/theme";

export default function PlaybackSettingsScreen() {
  const crossfadeEnabled = usePlayerStore((s) => s.crossfadeEnabled);
  const crossfadeSeconds = usePlayerStore((s) => s.crossfadeSeconds);
  const setCrossfadeEnabled = usePlayerStore((s) => s.setCrossfadeEnabled);
  const setCrossfadeSeconds = usePlayerStore((s) => s.setCrossfadeSeconds);

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
          Track transitions
        </Text>

        <View className="flex-row items-start justify-between">
          <View className="mr-4 flex-1">
            <Text className="text-[17px] font-semibold" style={{ color: colors.foreground }}>
              Crossfade
            </Text>
            <Text className="mt-1 text-[13px] leading-5" style={{ color: colors.muted }}>
              Blend the end of one track into the next so there's no silence between songs.
            </Text>
          </View>
          <Switch
            value={crossfadeEnabled}
            onValueChange={setCrossfadeEnabled}
            trackColor={{ true: "rgba(255,255,255,0.42)", false: "#3a3a3a" }}
            thumbColor="#fff"
          />
        </View>

        {crossfadeEnabled ? (
          <View className="mt-6">
            <Slider
              minimumValue={0}
              maximumValue={12}
              step={1}
              value={crossfadeSeconds}
              onValueChange={setCrossfadeSeconds}
              minimumTrackTintColor={colors.emerald}
              maximumTrackTintColor="rgba(255,255,255,0.2)"
              thumbTintColor="#fff"
            />
            <View className="flex-row items-center justify-between">
              <Text className="text-xs" style={{ color: colors.muted }}>
                0 sec
              </Text>
              <Text className="text-xs font-semibold" style={{ color: colors.emerald }}>
                {crossfadeSeconds} sec
              </Text>
              <Text className="text-xs" style={{ color: colors.muted }}>
                12 sec
              </Text>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
