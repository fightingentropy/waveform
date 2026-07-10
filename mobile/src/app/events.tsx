import { type ReactNode } from "react";
import { Linking, ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronLeft, MapPin } from "lucide-react-native";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { useApiData } from "@/lib/api";
import { formatEventDate, type LiveEvent, type LiveEventSection } from "@/lib/live-events";
import { colors } from "@/theme";

function Chip({ label, icon, outlined }: { label: string; icon?: ReactNode; outlined?: boolean }) {
  return (
    <View
      className="flex-row items-center gap-1.5 rounded-full px-4 py-2"
      style={{
        backgroundColor: outlined ? "transparent" : "rgba(255,255,255,0.14)",
        borderWidth: outlined ? 1 : 0,
        borderColor: "#c9923f",
      }}
    >
      {icon}
      <Text className="text-sm font-medium" style={{ color: colors.foreground }}>
        {label}
      </Text>
    </View>
  );
}

function EventCard({ event, width }: { event: LiveEvent; width: number }) {
  const { month, day } = formatEventDate(event.date);
  const content = (
    <>
      <View style={{ width, height: width, borderRadius: 10, overflow: "hidden", backgroundColor: colors.card }}>
        <CoverImage src={event.imageUrl} style={{ width: "100%", height: "100%" }} />
        <View style={{ position: "absolute", top: 8, left: 8, alignItems: "center", borderRadius: 8, backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 10, paddingVertical: 5 }}>
          <Text style={{ color: "#fff", fontSize: 12, lineHeight: 14 }}>{month}</Text>
          <Text style={{ color: "#fff", fontSize: 18, fontWeight: "800", lineHeight: 20 }}>{day}</Text>
        </View>
      </View>
      <View className="mt-2">
        <Text numberOfLines={2} className="text-[15px] font-bold leading-5" style={{ color: colors.foreground }}>
          {event.artists}
        </Text>
      </View>
      <Text numberOfLines={2} className="mt-1 text-sm leading-4" style={{ color: colors.muted }}>
        {event.venue}
      </Text>
    </>
  );
  return event.url ? (
    <PressableScale
      scaleTo={0.98}
      onPress={() => void Linking.openURL(event.url!)}
      accessibilityRole="link"
      accessibilityLabel={`View tickets for ${event.artists}`}
      style={{ width }}
    >
      {content}
    </PressableScale>
  ) : (
    <View style={{ width }}>{content}</View>
  );
}

export default function EventsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const cardWidth = Math.round(width * 0.56);
  const { data, loading, error, retry } = useApiData<{ sections: LiveEventSection[] }>("/api/events", { sections: [] });
  const today = new Date().toISOString().slice(0, 10);
  const sections = data.sections
    .map((section) => ({ ...section, events: section.events.filter((event) => event.date >= today) }))
    .filter((section) => section.events.length > 0);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ paddingBottom: CONTENT_BOTTOM_INSET }} showsVerticalScrollIndicator={false}>
        {/* purple gradient header */}
        <LinearGradient colors={["#6d28d9", "#3b1c74", colors.background]} style={{ paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 18 }}>
          <View className="flex-row items-center">
            <PressableScale onPress={() => router.back()} hitSlop={8} accessibilityLabel="Back">
              <View>
                <ChevronLeft size={28} color="#fff" />
              </View>
            </PressableScale>
          </View>
          <Text className="mt-2 text-4xl font-extrabold" style={{ color: "#fff" }}>
            Live Events
          </Text>
          <View className="mt-4 flex-row gap-2">
            <Chip label="London" outlined icon={<MapPin size={15} color="#c9923f" />} />
          </View>
        </LinearGradient>

        {loading && sections.length === 0 ? (
          <Text className="px-4 py-10 text-center" style={{ color: colors.muted }}>Loading events…</Text>
        ) : error ? (
          <View className="mx-4 mt-6 rounded-xl border p-5" style={{ borderColor: "rgba(248,113,113,0.3)" }}>
            <Text style={{ color: "#f87171" }}>{error}</Text>
            <PressableScale onPress={retry} className="mt-4 self-start rounded-full bg-white px-4 py-2">
              <Text className="font-semibold text-black">Retry</Text>
            </PressableScale>
          </View>
        ) : sections.length === 0 ? (
          <Text className="px-4 py-10 text-center" style={{ color: colors.muted }}>
            No upcoming London events are available right now.
          </Text>
        ) : sections.map((section) => (
          <View key={section.key} className="mt-6">
            <View className="flex-row items-end justify-between px-4">
              <View className="min-w-0 flex-1">
                <Text className="text-sm" style={{ color: colors.muted }}>
                  {section.eyebrow}
                </Text>
                <Text className="mt-0.5 text-2xl font-bold" style={{ color: colors.foreground }}>
                  {section.title}
                </Text>
              </View>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 16, paddingTop: 14 }}>
              {section.events.map((event) => (
                <EventCard key={event.id} event={event} width={cardWidth} />
              ))}
            </ScrollView>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
