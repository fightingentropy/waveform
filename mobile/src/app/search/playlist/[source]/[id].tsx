import { Redirect, useLocalSearchParams } from "expo-router";
import { PlaylistDetailScreen } from "@/app/playlist/[id]";
import type { CatalogProvider } from "@/lib/api";

function isCatalogProvider(value: string | undefined): value is CatalogProvider {
  return value === "spotify" || value === "youtube";
}

export default function CatalogPlaylistScreen() {
  const { source, id } = useLocalSearchParams<{ source: string; id: string }>();
  if (!isCatalogProvider(source) || !id) return <Redirect href="/search" />;
  const apiPath =
    source === "youtube"
      ? `/api/playlist/yt-mix-${encodeURIComponent(id)}`
      : `/api/catalog/spotify/playlists/${encodeURIComponent(id)}`;

  return (
    <PlaylistDetailScreen
      playlistId={`catalog:${source}:${id}`}
      apiPath={apiPath}
      queueContextKey={`playlist:catalog:${source}:${id}`}
    />
  );
}
