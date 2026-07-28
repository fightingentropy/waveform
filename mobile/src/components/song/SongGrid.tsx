import { type ReactElement, useCallback, useState } from "react";
import { FlatList, View } from "react-native";
import { LayoutGrid, Rows3 } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { SongCard } from "@/components/song/SongCard";
import { SongListItem } from "@/components/song/SongListItem";
import { CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { colors } from "@/theme";
import { toggleSongInList } from "@/audio/actions";
import type { PlayerSong } from "@/types/player";

type Mode = "grid" | "list";

// Replaces src/components/SongGrid.tsx (responsive grid + LayoutGrid/Rows3 toggle).
// FlatList-based so it scrolls large libraries efficiently and is the screen's
// scroll container (header via ListHeaderComponent).
export function SongGrid({
  songs,
  header,
  emptyComponent,
  footer,
  onEndReached,
  showToggle = true,
  initialMode = "grid",
  contentBottomInset = CONTENT_BOTTOM_INSET,
  contextKey,
  playlistContext,
}: {
  songs: PlayerSong[];
  header?: ReactElement | null;
  emptyComponent?: ReactElement | null;
  footer?: ReactElement | null;
  onEndReached?: () => void;
  showToggle?: boolean;
  initialMode?: Mode;
  contentBottomInset?: number;
  // Tags playback started from a row tap with the collection it came from, so
  // that collection's Play button stays in sync (Pause/resume vs restart).
  contextKey?: string;
  // The editable playlist these rows belong to — enables per-row "Remove from
  // this playlist". Pass a STABLE object (useMemo) so list rows stay memoized.
  playlistContext?: { id: string; name: string };
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const numColumns = mode === "grid" ? 2 : 1;

  const renderItem = useCallback(
    ({ item, index }: { item: PlayerSong; index: number }) => {
      const onPress = () => toggleSongInList(songs, index, contextKey);
      if (mode === "grid") {
        return (
          <View style={{ flex: 1 / numColumns, maxWidth: `${100 / numColumns}%` }}>
            <SongCard song={item} onPress={onPress} />
          </View>
        );
      }
      return <SongListItem song={item} onPress={onPress} playlist={playlistContext} />;
    },
    [mode, numColumns, songs, contextKey, playlistContext],
  );

  const toggleBar = showToggle ? (
    <View className="flex-row justify-end px-4 pb-2">
      <PressableScale onPress={() => setMode((m) => (m === "grid" ? "list" : "grid"))} hitSlop={8}>
        <View className="rounded-full p-2">
          {mode === "grid" ? <Rows3 size={20} color={colors.iconIdle} /> : <LayoutGrid size={20} color={colors.iconIdle} />}
        </View>
      </PressableScale>
    </View>
  ) : null;

  return (
    <FlatList
      // key forces a remount when numColumns changes (FlatList requirement).
      key={mode}
      data={songs}
      keyExtractor={(item, index) => `${item.id}:${index}`}
      renderItem={renderItem}
      numColumns={numColumns}
      columnWrapperStyle={numColumns > 1 ? { gap: 12, paddingHorizontal: 16 } : undefined}
      ItemSeparatorComponent={() => <View style={{ height: numColumns > 1 ? 12 : 2 }} />}
      ListHeaderComponent={
        <View>
          {header}
          {toggleBar}
        </View>
      }
      ListEmptyComponent={emptyComponent}
      ListFooterComponent={footer}
      contentContainerStyle={{ paddingBottom: contentBottomInset, paddingTop: 4 }}
      onEndReached={onEndReached}
      onEndReachedThreshold={0.6}
      showsVerticalScrollIndicator={false}
    />
  );
}
