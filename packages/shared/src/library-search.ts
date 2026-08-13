export function normalizeLibrarySearchQuery(value: string): string {
  return value.trim().toLowerCase().slice(0, 100);
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function songMatchesLibraryQuery(
  song: { title: string; artist: string },
  query: string,
): boolean {
  const needle = normalizeLibrarySearchQuery(query);
  if (!needle) return true;
  return song.title.toLowerCase().includes(needle) || song.artist.toLowerCase().includes(needle);
}
