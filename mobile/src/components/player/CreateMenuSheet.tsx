import { type ReactNode } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Svg, { Circle, Path } from "react-native-svg";
import { Blend, CodeXml, Folder, Music, SlidersVertical, Users } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { createPlaylist } from "@/lib/playlist-actions";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

// The "Create" sheet, opened from the Create (+) tab. Mirrors Spotify's create
// menu: a column of options, each a round icon chip + title (+ optional Beta
// badge) + one-line description. Only actions that are actually implemented are
// rendered; unfinished controls must not look interactive.

type Option = {
  key: string;
  title: string;
  subtitle: string;
  beta?: boolean;
  icon: (size: number, color: string) => ReactNode;
  onPress?: () => void;
};

// Jam glyph (a person + sound waves) — lucide has no close match, so draw it:
// filled head + shoulders silhouette, two stroked arcs for the waves.
function JamGlyph({ size, color }: { size: number; color: string }) {
  return (
    <Svg viewBox="0 0 24 24" width={size} height={size}>
      <Circle cx="8.5" cy="6.8" r="3.3" fill={color} />
      <Path d="M3 20.5c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6z" fill={color} />
      <Path d="M16.4 8.4a4.7 4.7 0 0 1 0 7.2" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
      <Path d="M19.2 5.8a8.2 8.2 0 0 1 0 12.4" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

const OPTIONS: Option[] = [
  { key: "playlist", title: "Playlist", subtitle: "Create a playlist with songs or episodes", icon: (s, c) => <Music size={s} color={c} /> },
  { key: "collab", title: "Collaborative playlist", subtitle: "Create a playlist together with friends", icon: (s, c) => <Users size={s} color={c} fill={c} /> },
  { key: "mixed", title: "Mixed Playlist", subtitle: "Mix songs with smooth transitions", beta: true, icon: (s, c) => <SlidersVertical size={s} color={c} /> },
  { key: "blend", title: "Blend", subtitle: "Combine your friends’ tastes into a playlist", icon: (s, c) => <Blend size={s} color={c} /> },
  { key: "prompted", title: "Prompted Playlist", subtitle: "Generate a playlist that curates and updates", beta: true, icon: (s, c) => <CodeXml size={s} color={c} /> },
  { key: "jam", title: "Jam", subtitle: "Listen together from anywhere", icon: (s, c) => <JamGlyph size={s} color={c} /> },
  { key: "folder", title: "Folder", subtitle: "Organize your playlists", icon: (s, c) => <Folder size={s} color={c} /> },
];

function BetaBadge() {
  return (
    <View style={{ backgroundColor: colors.green, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
      <Text style={{ color: "#000", fontSize: 11, fontWeight: "800" }}>Beta</Text>
    </View>
  );
}

function OptionRow({ option, onClose }: { option: Option; onClose: () => void }) {
  return (
    <PressableScale
      scaleTo={1}
      onPress={() => {
        option.onPress?.();
        onClose();
      }}
      className="flex-row items-center gap-4 px-5"
      style={{ paddingVertical: 13 }}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: "rgba(255,255,255,0.07)",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {option.icon(24, colors.foreground)}
      </View>
      <View className="min-w-0 flex-1">
        <View className="flex-row items-center gap-2">
          <Text style={{ color: colors.foreground, fontSize: 16, fontWeight: "700" }}>{option.title}</Text>
          {option.beta ? <BetaBadge /> : null}
        </View>
        <Text numberOfLines={2} style={{ color: colors.muted, fontSize: 13, marginTop: 2 }}>
          {option.subtitle}
        </Text>
      </View>
    </PressableScale>
  );
}

export function CreateMenuSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const router = useRouter();
  const openNamePrompt = useUiStore((s) => s.openNamePrompt);

  // "Playlist" is the only wired option: prompt for a name, create it in D1, then
  // open the new (empty) playlist so the user can start adding songs.
  const handleCreatePlaylist = () => {
    openNamePrompt({
      title: "Give your playlist a name",
      initialValue: "",
      confirmLabel: "Create",
      placeholder: "My playlist",
      onSubmit: async (name) => {
        try {
          const created = await createPlaylist(name);
          router.push(`/playlist/${created.id}`);
        } catch (error) {
          Alert.alert("Couldn't create playlist", error instanceof Error ? error.message : "Please try again.");
        }
      },
    });
  };

  const options = OPTIONS
    .map((o) => (o.key === "playlist" ? { ...o, onPress: handleCreatePlaylist } : o))
    .filter((o) => typeof o.onPress === "function");

  return (
    <Sheet visible={visible} onClose={onClose} heightPct={0.8} zIndex={150}>
      <ScrollView contentContainerStyle={{ paddingTop: 6, paddingBottom: 28 }} showsVerticalScrollIndicator={false}>
        {options.map((o) => (
          <OptionRow key={o.key} option={o} onClose={onClose} />
        ))}
      </ScrollView>
    </Sheet>
  );
}
