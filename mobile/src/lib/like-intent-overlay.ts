import type { LikeOutboxState, QueuedLikeIntent } from "@/lib/offline-mutation-policy";

export function protectLikeBaselines(
  incomingIds: readonly string[],
  previousIds: readonly string[],
  outbox: Pick<LikeOutboxState, "baselines" | "lockedSongIds">,
  canonicalId: (songId: string) => string = (songId) => songId,
): string[] {
  const incoming = new Set(incomingIds);
  const previous = new Set(previousIds);

  for (const songId of outbox.lockedSongIds) {
    const canonical = canonicalId(songId);
    const explicit = Object.prototype.hasOwnProperty.call(outbox.baselines, songId)
      ? outbox.baselines[songId]
      : undefined;
    const wasLiked =
      typeof explicit === "boolean"
        ? explicit
        : Array.from(previous).some((id) => canonicalId(id) === canonical);
    for (const id of Array.from(incoming)) {
      if (canonicalId(id) === canonical) incoming.delete(id);
    }
    if (wasLiked) incoming.add(canonical);
  }

  return Array.from(incoming);
}

export function applyQueuedLikeIntents(
  liked: Record<string, true>,
  intents: Readonly<Record<string, QueuedLikeIntent>>,
  relatedIds: (songId: string) => readonly string[] = (songId) => [songId],
): Record<string, true> {
  const next = { ...liked };
  for (const intent of Object.values(intents)) {
    for (const id of relatedIds(intent.songId)) {
      if (intent.nextLiked) next[id] = true;
      else delete next[id];
    }
  }
  return next;
}

export function updateAuthoritativeLikedIds(
  rawIds: readonly string[],
  songId: string,
  nextLiked: boolean,
  canonicalSongId = songId,
  canonicalId: (id: string) => string = (id) => id,
): string[] {
  const next = new Set(
    rawIds.filter(
      (id) =>
        id !== songId &&
        id !== canonicalSongId &&
        canonicalId(id) !== canonicalSongId,
    ),
  );
  if (nextLiked) next.add(canonicalSongId);
  return Array.from(next);
}
