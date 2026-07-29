import { type ReactNode, useMemo, useState } from "react";
import { FlatList, Text, useWindowDimensions, View } from "react-native";
import { useRouter } from "expo-router";
import {
  ArrowDownUp,
  Download,
  Heart,
  LayoutGrid,
  List as ListIcon,
  type LucideIcon,
  Music,
  Pin,
  Plus,
  Podcast,
  RadioTower,
  Search,
  Ticket,
} from "lucide-react-native";
import { Screen, CONTENT_BOTTOM_INSET } from "@/components/ui/Screen";
import { PressableScale } from "@/components/ui/PressableScale";
import { CoverImage } from "@/components/CoverImage";
import { ProfileButton } from "@/components/profile/ProfileButton";
import { Skeleton } from "@/components/ui/Skeleton";
import { type LibraryPayload, useApiData, withAccountScope } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { canDeletePlaylist } from "@/lib/playlist-policy";
import { PODCAST_SHOWS } from "@/lib/podcasts";
import { useLibraryPinsStore } from "@/store/library-pins";
import { useLibraryViewStore } from "@/store/library-view";
import { librarySortLabel, useLibrarySortStore } from "@/store/library-sort";
import { useUserPodcastsStore } from "@/store/user-podcasts";
import { useUiStore } from "@/store/ui";
import { colors } from "@/theme";

type Filter = "all" | "playlists" | "podcasts";

// `cover` is size-aware so the same item renders small (56) in the list and large
// (a grid cell) in the grid — Spotify shows both layouts.
type LibItem = {
  key: string;
  cover: (size: number) => ReactNode;
  title: string;
  subtitle: string;
  pinned?: boolean;
  shortcut?: boolean;
  // Whether long-pressing the row offers Pin/Unpin (content items, not the
  // navigation shortcuts like Radio / Upload / Live Events).
  pinnable?: boolean;
  // Epoch ms used by the "Recently added" sort. Undefined for items without a
  // creation date (the nav shortcuts) — they sort as newest and stay on top.
  addedAt?: number;
  playlist?: {
    id: string;
    canDelete: boolean;
  };
  onPress: () => void;
};

const GRID_GAP = 14;

function iconCover(renderIcon: (size: number) => ReactNode) {
  return (size: number): ReactNode => {
    return (
      <View
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 8,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: "rgba(255,255,255,0.075)",
        }}
      >
        {renderIcon(Math.round(size * 0.36))}
      </View>
    );
  };
}

function imageCover(src?: string | null) {
  return (size: number): ReactNode => {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          borderCurve: "continuous",
          overflow: "hidden",
          backgroundColor: colors.card,
        }}
      >
        {src ? (
          <CoverImage src={src} style={{ width: "100%", height: "100%" }} />
        ) : (
          <View className="h-full w-full items-center justify-center">
            <Music size={Math.round(size * 0.38)} color={colors.muted} />
          </View>
        )}
      </View>
    );
  };
}

function SubtitleLine({ pinned, subtitle, small }: { pinned?: boolean; subtitle: string; small?: boolean }) {
  return (
    <View className="mt-0.5 flex-row items-center gap-1">
      {pinned ? <Pin size={small ? 11 : 13} color={colors.foreground} fill={colors.foreground} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, fontSize: small ? 12 : 14, color: colors.muted }}>
        {subtitle}
      </Text>
    </View>
  );
}

function ListRow({ item, onLongPress }: { item: LibItem; onLongPress?: () => void }) {
  return (
    <PressableScale
      scaleTo={1}
      onPress={item.onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${item.subtitle}${item.pinned ? ", pinned" : ""}`}
      className="flex-row items-center gap-3"
      style={{
        paddingHorizontal: 16,
        paddingVertical: 7,
      }}
    >
      {item.cover(item.shortcut ? 44 : 62)}
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          style={{ color: colors.foreground, fontSize: 16, fontWeight: "600", letterSpacing: -0.2 }}
        >
          {item.title}
        </Text>
        <SubtitleLine pinned={item.pinned} subtitle={item.subtitle} />
      </View>
    </PressableScale>
  );
}

function GridCell({
  item,
  size,
  onLongPress,
}: {
  item: LibItem;
  size: number;
  onLongPress?: () => void;
}) {
  return (
    <PressableScale
      scaleTo={0.97}
      onPress={item.onPress}
      onLongPress={onLongPress}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}, ${item.subtitle}${item.pinned ? ", pinned" : ""}`}
      style={{ width: size, paddingBottom: 6 }}
    >
      {item.cover(size)}
      <Text
        numberOfLines={2}
        style={{
          color: colors.foreground,
          fontSize: 15,
          fontWeight: "700",
          letterSpacing: -0.25,
          lineHeight: 19,
          marginTop: 9,
        }}
      >
        {item.title}
      </Text>
      <SubtitleLine pinned={item.pinned} subtitle={item.subtitle} small />
    </PressableScale>
  );
}

type AddAction = { key: string; label: string; Icon: LucideIcon; onPress: () => void };

function LibraryAddActionsList({ actions }: { actions: AddAction[] }) {
  return (
    <View style={{ paddingTop: 8, borderTopWidth: 0.5, borderTopColor: colors.line }}>
      {actions.map((a) => (
        <PressableScale
          key={a.key}
          scaleTo={1}
          onPress={a.onPress}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          className="flex-row items-center px-4"
          style={{ minHeight: 48, gap: 12 }}
        >
          <View style={{ width: 32, alignItems: "center" }}>
            <a.Icon size={20} color={colors.iconIdle} />
          </View>
          <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "500" }}>
            {a.label}
          </Text>
        </PressableScale>
      ))}
    </View>
  );
}

function FilterButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      style={{
        minHeight: 44,
        paddingHorizontal: 2,
        marginRight: 24,
        alignItems: "center",
        justifyContent: "center",
        borderBottomWidth: active ? 1.5 : 0,
        borderBottomColor: colors.foreground,
      }}
    >
      <Text
        style={{
          color: active ? colors.foreground : colors.muted,
          fontSize: 14,
          fontWeight: active ? "600" : "500",
        }}
      >
        {label}
      </Text>
    </PressableScale>
  );
}

export default function LibraryScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const { user, status } = useAuth();
  const { data, loading } = useApiData<LibraryPayload>(
    withAccountScope("/api/library", user?.id ?? status),
    { playlists: [], userId: null },
    { enabled: status !== "loading", keepPreviousData: true },
  );
  const [filter, setFilter] = useState<Filter>("all");
  const view = useLibraryViewStore((s) => s.view);
  const toggleView = useLibraryViewStore((s) => s.toggleView);
  const sort = useLibrarySortStore((s) => s.sort);
  const userShows = useUserPodcastsStore((s) => s.shows);
  const pinnedKeys = useLibraryPinsStore((s) => s.pinned);
  const openLibraryActions = useUiStore((s) => s.openLibraryActions);
  const openLibrarySort = useUiStore((s) => s.openLibrarySort);

  const gridColumns = width >= 900 ? 5 : width >= 700 ? 4 : 2;
  const cellWidth = Math.floor((width - 32 - GRID_GAP * (gridColumns - 1)) / gridColumns);

  const items = useMemo<LibItem[]>(() => {
    const owner = user?.name || user?.email || "You";
    const liked: LibItem = {
      key: "liked",
      cover: iconCover((s) => <Heart size={s} color={colors.foreground} fill={colors.foreground} />),
      title: "Liked Songs",
      subtitle: `Playlist • ${owner}`,
      shortcut: true,
      pinnable: true,
      onPress: () => router.push("/liked"),
    };
    const radio: LibItem = {
      key: "radio",
      cover: iconCover((s) => <RadioTower size={s} color={colors.iconIdle} />),
      title: "Radio Stations",
      subtitle: "Live streams",
      shortcut: true,
      onPress: () => router.push("/radio"),
    };
    const podcastsShortcut: LibItem = {
      key: "podcasts",
      cover: iconCover((s) => <Podcast size={s} color={colors.iconIdle} />),
      title: "Podcasts",
      subtitle: "Shows & episodes",
      shortcut: true,
      onPress: () => router.push("/podcasts"),
    };
    const events: LibItem = {
      key: "events",
      cover: iconCover((s) => <Ticket size={s} color={colors.iconIdle} />),
      title: "Live Events",
      subtitle: "Concerts & venues near you",
      shortcut: true,
      onPress: () => router.push("/events"),
    };
    const playlists: LibItem[] = data.playlists.map((pl) => {
      const added = pl.createdAt ? Date.parse(pl.createdAt) : NaN;
      return {
        key: `pl-${pl.id}`,
        cover: imageCover(pl.imageUrl),
        title: pl.name,
        subtitle: `Playlist • ${owner}`,
        pinnable: true,
        addedAt: Number.isNaN(added) ? undefined : added,
        playlist: { id: pl.id, canDelete: canDeletePlaylist(pl) },
        onPress: () => router.push(`/playlist/${pl.id}`),
      };
    });
    const shows: LibItem[] = [...userShows, ...PODCAST_SHOWS].map((show) => ({
      key: `pod-${show.id}`,
      cover: imageCover(show.imageUrl),
      title: show.title,
      subtitle: `Podcast • ${show.author}`,
      pinnable: true,
      onPress: () => router.push(`/podcasts/${show.id}`),
    }));

    if (filter === "playlists") return [liked, ...playlists];
    if (filter === "podcasts") return shows;
    return [liked, radio, podcastsShortcut, events, ...playlists];
  }, [filter, data.playlists, userShows, user, router]);

  // Pinned items float to the top in pin order (newest first); the rest follow the
  // chosen sort. `pinned` drives the pin indicator on the row.
  const ordered = useMemo(() => {
    const rank = new Map(pinnedKeys.map((k, i) => [k, i] as const));
    const pinnedItems = items
      .filter((it) => rank.has(it.key))
      .sort((a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0));
    const rest = items.filter((it) => !rank.has(it.key));
    // "Recents" keeps the natural (API) order; the others sort the unpinned items.
    // Both sorts are stable, so ties (and dateless nav shortcuts) hold their order.
    const sortedRest =
      sort === "alphabetical"
        ? [...rest].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }))
        : sort === "recently-added"
          ? [...rest].sort((a, b) => (b.addedAt ?? Number.MAX_SAFE_INTEGER) - (a.addedAt ?? Number.MAX_SAFE_INTEGER))
          : rest;
    return [...pinnedItems, ...sortedRest].map((it) => ({ ...it, pinned: rank.has(it.key) }));
  }, [items, pinnedKeys, sort]);

  const handleLongPress = (item: LibItem) => {
    if (!item.pinnable) return;
    openLibraryActions({
      key: item.key,
      title: item.title,
      subtitle: item.subtitle,
      cover: item.cover,
      playlist: item.playlist,
    });
  };

  const showPlaylistSkeleton = loading && data.playlists.length === 0 && filter !== "podcasts";

  const addActions: AddAction[] = [
    { key: "add-artists", label: "Add artists", Icon: Plus, onPress: () => router.push("/search") },
    { key: "add-podcasts", label: "Add podcasts", Icon: Plus, onPress: () => router.push("/podcasts/add") },
    { key: "add-events", label: "Add events & venues", Icon: Plus, onPress: () => router.push("/events") },
    { key: "import", label: "Import your music", Icon: Download, onPress: () => router.push("/upload") },
  ];

  const listHeader = (
    <View style={{ paddingTop: 18, paddingBottom: view === "grid" ? 10 : 0 }}>
      {/* header: title + search + add + avatar */}
      <View className="flex-row items-center px-4" style={{ marginBottom: 18 }}>
        <Text
          numberOfLines={1}
          style={{
            minWidth: 0,
            flex: 1,
            color: colors.foreground,
            fontSize: 34,
            fontWeight: "700",
            letterSpacing: -0.9,
            lineHeight: 40,
          }}
        >
          Library
        </Text>
        <View className="flex-row items-center">
          <PressableScale
            onPress={() => router.push("/search")}
            accessibilityRole="button"
            accessibilityLabel="Search"
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Search size={20} color={colors.foreground} strokeWidth={2.2} />
          </PressableScale>
          <PressableScale
            onPress={() => router.push("/upload")}
            accessibilityRole="button"
            accessibilityLabel="Add music"
            style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <Plus size={22} color={colors.foreground} strokeWidth={2.2} />
          </PressableScale>
          <View style={{ marginLeft: 4 }}>
            <ProfileButton size={38} />
          </View>
        </View>
      </View>

      {/* Flat text filters keep hierarchy without adding another capsule. */}
      <View className="px-4" style={{ marginBottom: 12 }}>
        <View className="self-start flex-row">
          <FilterButton label="All" active={filter === "all"} onPress={() => setFilter("all")} />
          <FilterButton
            label="Playlists"
            active={filter === "playlists"}
            onPress={() => setFilter((f) => (f === "playlists" ? "all" : "playlists"))}
          />
          <FilterButton
            label="Podcasts"
            active={filter === "podcasts"}
            onPress={() => setFilter((f) => (f === "podcasts" ? "all" : "podcasts"))}
          />
        </View>
      </View>

      {/* sort + view toggle */}
      <View className="flex-row items-center justify-between px-4" style={{ marginBottom: 8 }}>
        <PressableScale
          onPress={openLibrarySort}
          accessibilityRole="button"
          accessibilityLabel="Change sort order"
          style={{ minHeight: 44, paddingRight: 12, alignItems: "center", justifyContent: "center" }}
        >
          {/* flex-row on an inner View, not the Pressable (RN/Fabric row→column quirk) */}
          <View className="flex-row items-center gap-2">
            <ArrowDownUp size={15} color={colors.iconIdle} />
            <Text style={{ color: colors.muted, fontSize: 13, fontWeight: "500" }}>
              {librarySortLabel(sort)}
            </Text>
          </View>
        </PressableScale>
        <PressableScale
          onPress={toggleView}
          accessibilityRole="button"
          accessibilityLabel="Toggle layout"
          style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
        >
          {view === "grid" ? (
            <ListIcon size={19} color={colors.iconIdle} />
          ) : (
            <LayoutGrid size={18} color={colors.iconIdle} />
          )}
        </PressableScale>
      </View>
    </View>
  );

  const listFooter = (
    <View>
      {showPlaylistSkeleton && view === "list" ? (
        <View className="px-4 pt-2" style={{ gap: 14 }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <View key={i} className="flex-row items-center gap-3">
              <Skeleton width={62} height={62} radius={10} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={"60%"} height={14} />
                <Skeleton width={"30%"} height={12} />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {filter === "podcasts" && ordered.length === 0 ? (
        <Text className="px-4 py-4 text-sm" style={{ color: colors.muted }}>
          No podcasts yet.
        </Text>
      ) : null}

      {filter === "all" ? (
        <View style={{ marginTop: view === "grid" ? 20 : 8 }}>
          <LibraryAddActionsList actions={addActions} />
        </View>
      ) : null}
    </View>
  );

  return (
    <Screen>
      <FlatList
        key={view}
        data={ordered}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) =>
          view === "grid" ? (
            <GridCell item={item} size={cellWidth} onLongPress={() => handleLongPress(item)} />
          ) : (
            <ListRow item={item} onLongPress={() => handleLongPress(item)} />
          )
        }
        numColumns={view === "grid" ? gridColumns : 1}
        columnWrapperStyle={
          view === "grid" ? { gap: GRID_GAP, paddingHorizontal: 16 } : undefined
        }
        ItemSeparatorComponent={
          view === "grid" ? () => <View style={{ height: GRID_GAP }} /> : undefined
        }
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        contentContainerStyle={{
          paddingBottom: CONTENT_BOTTOM_INSET,
          paddingTop: 0,
        }}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={7}
        showsVerticalScrollIndicator={false}
      />
    </Screen>
  );
}
