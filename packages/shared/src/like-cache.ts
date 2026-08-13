export type LikedSongLike = {
  id: string;
};

export function hasStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function updateLikedIdsInPayload(data: unknown, songId: string, nextLiked: boolean): boolean {
  if (!data || typeof data !== "object") return false;
  const target = data as { likedSongIds?: unknown; likes?: unknown };
  let changed = false;
  if (hasStringArray(target.likedSongIds)) {
    const set = new Set(target.likedSongIds);
    const had = set.has(songId);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likedSongIds = Array.from(set);
    changed = had !== nextLiked;
  }
  if (hasStringArray(target.likes)) {
    const set = new Set(target.likes);
    const had = set.has(songId);
    if (nextLiked) set.add(songId);
    else set.delete(songId);
    target.likes = Array.from(set);
    changed = changed || had !== nextLiked;
  }
  return changed;
}

export function updateLikedSongsInPayload(
  data: unknown,
  payload: { songId: string; nextLiked: boolean; song?: LikedSongLike },
): boolean {
  if (!data || typeof data !== "object" || !("songs" in data)) return false;
  const target = data as { songs?: unknown };
  if (!Array.isArray(target.songs)) return false;
  const songs = target.songs;
  if (payload.nextLiked) {
    if (!payload.song) return false;
    const exists = songs.some((song) => {
      return song && typeof song === "object" && (song as LikedSongLike).id === payload.songId;
    });
    if (exists) return false;
    target.songs = [payload.song, ...songs];
    return true;
  }
  const before = songs.length;
  const nextSongs = songs.filter((song) => {
    return !(song && typeof song === "object" && (song as LikedSongLike).id === payload.songId);
  });
  target.songs = nextSongs;
  return before !== nextSongs.length;
}
