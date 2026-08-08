import { type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { CoverImage } from "@/components/CoverImage";
import { PressableScale } from "@/components/ui/PressableScale";
import { EmptyState, SignedOutPrompt } from "@/components/ui/States";
import { type ListeningStatsPayload, type ListeningWeek, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { playSong } from "@/audio/actions";
import { colors } from "@/theme";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Monday-anchored ISO date for a Date, in UTC (matches the worker's bucketing).
function mondayUtc(d: Date): string {
  const dow = (d.getUTCDay() + 6) % 7;
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  return m.toISOString().slice(0, 10);
}

function formatRange(startIso: string, endIso: string): string {
  const s = new Date(`${startIso}T00:00:00Z`);
  const e = new Date(`${endIso}T00:00:00Z`);
  const sM = MONTHS[s.getUTCMonth()];
  const eM = MONTHS[e.getUTCMonth()];
  const sameMonth = s.getUTCMonth() === e.getUTCMonth();
  return sameMonth
    ? `${sM} ${s.getUTCDate()} – ${e.getUTCDate()}`
    : `${sM} ${s.getUTCDate()} – ${eM} ${e.getUTCDate()}`;
}

function weekLabel(weekStart: string): "This week" | "Last week" | null {
  const now = mondayUtc(new Date());
  if (weekStart === now) return "This week";
  const last = new Date(`${now}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 7);
  if (weekStart === last.toISOString().slice(0, 10)) return "Last week";
  return null;
}

function StatCard({ label, onPress, children }: { label: string; onPress?: () => void; children: ReactNode }) {
  const body = (
    <View style={{ backgroundColor: "#1c1c1e", borderRadius: 12, padding: 14 }}>
      <Text className="text-xs font-medium" style={{ color: colors.muted }}>
        {label}
      </Text>
      {children}
    </View>
  );
  return onPress ? (
    <PressableScale onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      {body}
    </PressableScale>
  ) : (
    body
  );
}

function WeekSection({ week }: { week: ListeningWeek }) {
  const named = weekLabel(week.weekStart);
  const range = formatRange(week.weekStart, week.weekEnd);
  const topSong = week.topSong;
  const topArtist = week.topArtist;

  return (
    <View className="mb-9">
      <Text className="text-2xl font-extrabold" style={{ color: "#fff" }}>
        {named ?? range}
      </Text>
      {named ? (
        <Text className="mt-0.5 text-sm" style={{ color: colors.muted }}>
          {range}
        </Text>
      ) : null}

      <View className="mt-4 flex-row" style={{ gap: 12 }}>
        {/* left column: minutes + top artist */}
        <View className="flex-1" style={{ gap: 12 }}>
          <StatCard label="Minutes listened">
            <Text className="mt-1 text-4xl font-extrabold" style={{ color: "#fff" }}>
              {week.minutesListened}
            </Text>
          </StatCard>
          {topArtist ? (
            <StatCard label="Top artist">
              <Text numberOfLines={2} className="mt-1 text-lg font-bold" style={{ color: "#fff" }}>
                {topArtist.name}
              </Text>
              {topArtist.image ? (
                <View className="mt-3 overflow-hidden rounded-full" style={{ aspectRatio: 1 }}>
                  <CoverImage src={topArtist.image} style={{ width: "100%", height: "100%" }} />
                </View>
              ) : null}
            </StatCard>
          ) : null}
        </View>

        {/* right column: top song */}
        <View className="flex-1" style={{ gap: 12 }}>
          {topSong ? (
            <StatCard label="Top song" onPress={() => playSong(topSong)}>
              <Text numberOfLines={2} className="mt-1 text-lg font-bold" style={{ color: "#fff" }}>
                {topSong.title}
              </Text>
              <View className="mt-3 overflow-hidden rounded" style={{ aspectRatio: 1 }}>
                <CoverImage
                  src={topSong.imageUrl}
                  networkSrc={topSong.networkImageUrl}
                  offlineSongId={topSong.id}
                  style={{ width: "100%", height: "100%" }}
                  recyclingKey={topSong.id}
                />
              </View>
            </StatCard>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export default function ListeningStatsScreen() {
  const { user, status } = useAuth();
  const { data, loading } = useApiData<ListeningStatsPayload>(
    withAccountScope("/api/stats/listening", user?.id ?? status),
    { weeks: [] },
    { enabled: status === "authenticated", keepPreviousData: true },
  );

  if (status === "unauthenticated") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <SignedOutPrompt message="Sign in to see your listening stats." />
      </View>
    );
  }

  const weeks = data.weeks;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: CONTENT_BOTTOM_INSET }}>
        {weeks.length === 0 ? (
          loading ? null : (
            <View className="pt-16">
              <EmptyState
                title="No listening yet"
                subtitle="Play some music and your weekly stats will show up here."
              />
            </View>
          )
        ) : (
          weeks.map((w) => <WeekSection key={w.weekStart} week={w} />)
        )}
      </ScrollView>
    </View>
  );
}
