import { ScrollView, Text, View } from "react-native";
import { Pause, Play } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { RADIO_STATIONS } from "@/lib/radio-stations";
import { playSongs } from "@/audio/actions";
import { usePlayerStore } from "@/store/player";
import { colors } from "@/theme";

export default function RadioScreen() {
  const currentSongId = usePlayerStore((s) => s.currentSong?.id ?? null);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: CONTENT_BOTTOM_INSET }}>
      {RADIO_STATIONS.map((station) => {
        const active = currentSongId === station.id;
        return (
          <PressableScale
            key={station.id}
            onPress={() => (active ? toggle() : playSongs([station], 0))}
            className="overflow-hidden rounded-xl"
            style={{
              padding: 14,
              backgroundColor: colors.surface,
              borderWidth: active ? 1.5 : 0.7,
              borderColor: active ? colors.emerald : colors.hairline,
            }}
          >
            <View className="flex-row items-center gap-4">
              <View className="h-16 w-16 overflow-hidden rounded-lg">
                <CoverImage src={station.imageUrl} style={{ width: "100%", height: "100%" }} />
              </View>
              <View className="min-w-0 flex-1">
                <View className="mb-1 flex-row items-center gap-2">
                  <View className="h-2 w-2 rounded-full" style={{ backgroundColor: colors.emerald }} />
                  <Text className="text-[10px] font-bold uppercase tracking-widest" style={{ color: colors.muted }}>
                    Live
                  </Text>
                </View>
                <Text numberOfLines={1} className="text-lg font-bold" style={{ color: colors.foreground }}>
                  {station.title}
                </Text>
                <Text numberOfLines={1} className="text-sm" style={{ color: colors.muted }}>
                  {station.location} · {station.streamLabel}
                </Text>
              </View>
              <View className="h-12 w-12 items-center justify-center rounded-full" style={{ backgroundColor: colors.glassStrong }}>
                {active && isPlaying ? <Pause size={22} color="#fff" fill="#fff" /> : <Play size={22} color="#fff" fill="#fff" style={{ marginLeft: 2 }} />}
              </View>
            </View>
          </PressableScale>
        );
      })}
    </ScrollView>
  );
}
