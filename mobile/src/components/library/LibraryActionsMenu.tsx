import { Alert, Text, View } from "react-native";
import { Pin, Trash2 } from "lucide-react-native";
import { PressableScale } from "@/components/ui/PressableScale";
import { Sheet } from "@/components/ui/Sheet";
import { deletePlaylist } from "@/lib/playlist-actions";
import { useOnlineStatus } from "@/lib/use-connectivity";
import { colors } from "@/theme";
import { useUiStore } from "@/store/ui";
import { useLibraryPinsStore } from "@/store/library-pins";

// Long-press sheet for a Your Library row: Pin / Unpin for every content item,
// plus a confirmed destructive action for deletable playlists. Driven by
// ui.libraryActions, mounted globally in PlayerSheets so it overlays the tab bar
// and mini-player.
export function LibraryActionsMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const target = useUiStore((s) => s.libraryActions);
  const pinned = useLibraryPinsStore((s) => (target ? s.pinned.includes(target.key) : false));
  const togglePin = useLibraryPinsStore((s) => s.togglePin);
  const isOnline = useOnlineStatus();

  const confirmDelete = () => {
    if (!target?.playlist?.canDelete) return;
    const { id } = target.playlist;
    const name = target.title;
    onClose();

    if (!isOnline) {
      Alert.alert("You're offline", "Connect to the internet to delete this playlist.");
      return;
    }

    Alert.alert("Delete playlist?", `“${name}” will be removed. Its songs will stay in your library.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          void deletePlaylist(id).catch((error) =>
            Alert.alert(
              "Couldn't delete",
              error instanceof Error ? error.message : "Please try again.",
            ),
          ),
      },
    ]);
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      heightPct={target?.playlist?.canDelete ? 0.4 : 0.32}
      zIndex={200}
    >
      <View style={{ paddingBottom: 32 }}>
        {target ? (
          <>
            <View className="flex-row items-center gap-3 border-b px-5 pb-3 pt-1" style={{ borderColor: colors.line }}>
              {target.cover(48)}
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-base font-semibold" style={{ color: colors.foreground }}>
                  {target.title}
                </Text>
                <Text numberOfLines={1} className="text-sm" style={{ color: colors.muted }}>
                  {target.subtitle}
                </Text>
              </View>
            </View>
            <PressableScale
              scaleTo={1}
              onPress={() => {
                togglePin(target.key);
                onClose();
              }}
              accessibilityRole="button"
              accessibilityLabel={pinned ? `Unpin ${target.title}` : `Pin ${target.title} to top`}
              className="flex-row items-center gap-4 px-5 py-4"
            >
              <View style={{ width: 24 }}>
                <Pin size={22} color={colors.green} fill={colors.green} />
              </View>
              <Text className="text-base" style={{ color: colors.foreground }}>
                {pinned ? "Unpin" : "Pin to top"}
              </Text>
            </PressableScale>
            {target.playlist?.canDelete ? (
              <PressableScale
                scaleTo={1}
                onPress={confirmDelete}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${target.title}`}
                className="flex-row items-center gap-4 px-5 py-4"
              >
                <View style={{ width: 24 }}>
                  <Trash2 size={22} color="#ef4444" />
                </View>
                <Text className="text-base" style={{ color: "#ef4444" }}>
                  Delete playlist
                </Text>
              </PressableScale>
            ) : null}
          </>
        ) : null}
      </View>
    </Sheet>
  );
}
