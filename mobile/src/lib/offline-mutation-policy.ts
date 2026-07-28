import type { PlayerSong } from "@/types/player";

export const OFFLINE_MUTATION_MAX_ATTEMPTS = 5;
export const OFFLINE_MUTATION_TIMEOUT_MS = 15_000;

export type OfflineMutation =
  | {
      type: "like";
      payload: {
        songId: string;
        logicalSongId?: string;
        nextLiked: boolean;
        previousLiked?: boolean;
        song?: PlayerSong;
      };
    }
  | { type: "playlist-reorder"; payload: { playlistId: string; songIds: string[] } }
  | { type: "song-edit"; payload: Record<string, unknown> };

export type StoredOfflineMutation = OfflineMutation & {
  scope?: string;
  queuedAt?: number;
  attempts?: number;
  error?: string;
};

export type QueuedLikeIntent = {
  songId: string;
  nextLiked: boolean;
  previousLiked?: boolean;
  song?: PlayerSong;
};

export type LikeOutboxState = {
  // Latest still-retryable direction per song.
  intents: Record<string, QueuedLikeIntent>;
  // The first persisted pre-mutation direction anchors rollback across relaunches.
  baselines: Record<string, boolean>;
  // Includes active and exhausted rows so stale GETs cannot replace that baseline.
  lockedSongIds: string[];
};

export type OfflineMutationFailurePlan =
  | {
      kind: "auth-required" | "offline";
      nextAttempts: number;
      stop: true;
    }
  | {
      kind: "retry-retained";
      nextAttempts: number;
      stop: true;
    }
  | {
      kind: "retry-exhausted";
      nextAttempts: number;
      stop: false;
    };

// A queued mutation that will be retried must remain ahead of every later write.
// Otherwise a failed "like" followed by a successful "unlike" can replay in the
// opposite order on the next pass and leave the server with the stale value.
export function planOfflineMutationFailure({
  attempts,
  online,
  status,
  maxAttempts = OFFLINE_MUTATION_MAX_ATTEMPTS,
}: {
  attempts: number;
  online: boolean;
  status?: number;
  maxAttempts?: number;
}): OfflineMutationFailurePlan {
  if (status === 401 || status === 403) {
    return { kind: "auth-required", nextAttempts: attempts, stop: true };
  }
  if (!online) {
    return { kind: "offline", nextAttempts: attempts, stop: true };
  }

  const nextAttempts = attempts + 1;
  if (nextAttempts < maxAttempts) {
    return { kind: "retry-retained", nextAttempts, stop: true };
  }
  return { kind: "retry-exhausted", nextAttempts, stop: false };
}

export async function replayMutationsFifo<T>(
  targets: readonly T[],
  replay: (target: T) => Promise<"continue" | "stop">,
): Promise<void> {
  for (const target of targets) {
    if ((await replay(target)) === "stop") break;
  }
}

export function offlineMutationScope(mutation: Pick<StoredOfflineMutation, "scope">, currentScope: string): string {
  return mutation.scope?.trim() || currentScope;
}

export function createStoredOfflineMutation(
  mutation: OfflineMutation,
  capturedScope: string,
  queuedAt = Date.now(),
): StoredOfflineMutation {
  return {
    ...mutation,
    scope: capturedScope.trim() || "anonymous",
    queuedAt,
    attempts: 0,
  };
}

export function offlineMutationTarget(mutation: OfflineMutation): string | null {
  if (mutation.type === "like") {
    const songId = mutation.payload.logicalSongId || mutation.payload.songId;
    return songId ? `like:${songId}` : null;
  }
  if (mutation.type === "playlist-reorder") {
    return mutation.payload.playlistId
      ? `playlist-reorder:${mutation.payload.playlistId}`
      : null;
  }
  const songId = mutation.payload.songId;
  return typeof songId === "string" && songId ? `song-edit:${songId}` : null;
}

export function settleAppliedOfflineMutation(
  mutations: readonly StoredOfflineMutation[],
  appliedIndex: number,
  maxAttempts = OFFLINE_MUTATION_MAX_ATTEMPTS,
  currentScope = "anonymous",
  canonicalLikeId: (songId: string) => string = (songId) => songId,
): { mutations: StoredOfflineMutation[]; discardedFailures: number } {
  const applied = mutations[appliedIndex];
  if (!applied) return { mutations: Array.from(mutations), discardedFailures: 0 };
  const target =
    applied.type === "like"
      ? `like:${canonicalLikeId(
          applied.payload.logicalSongId || applied.payload.songId,
        )}`
      : offlineMutationTarget(applied);
  const appliedScope = offlineMutationScope(applied, currentScope);
  let discardedFailures = 0;
  const next = mutations.filter((mutation, index) => {
    if (index === appliedIndex) return false;
    // A later applied absolute intent is authoritative for this target. Keeping
    // an older dead letter would let a future manual retry reverse that intent.
    if (
      index < appliedIndex &&
      target &&
      offlineMutationScope(mutation, currentScope) === appliedScope &&
      (mutation.type === "like"
        ? `like:${canonicalLikeId(
            mutation.payload.logicalSongId || mutation.payload.songId,
          )}`
        : offlineMutationTarget(mutation)) === target &&
      (mutation.attempts ?? 0) >= maxAttempts
    ) {
      discardedFailures += 1;
      return false;
    }
    return true;
  });
  return { mutations: next, discardedFailures };
}

export function isOfflineMutationForScope(
  mutation: Pick<StoredOfflineMutation, "scope">,
  scope: string,
): boolean {
  return offlineMutationScope(mutation, scope) === scope;
}

export function shouldPublishOfflineMutationCounts(
  mutationScope: string,
  activeScope: string,
): boolean {
  return mutationScope === activeScope;
}

export function isOfflineMutationReplayCurrent(
  replayScope: string,
  replayGeneration: number,
  activeScope: string,
  activeGeneration: number,
): boolean {
  return replayScope === activeScope && replayGeneration === activeGeneration;
}

export function pendingOfflineMutations(
  mutations: readonly StoredOfflineMutation[],
  scope: string,
  maxAttempts = OFFLINE_MUTATION_MAX_ATTEMPTS,
): StoredOfflineMutation[] {
  return mutations.filter(
    (mutation) =>
      isOfflineMutationForScope(mutation, scope) &&
      (mutation.attempts ?? 0) < maxAttempts,
  );
}

export function offlineMutationCounts(
  mutations: readonly StoredOfflineMutation[],
  scope: string,
  maxAttempts = OFFLINE_MUTATION_MAX_ATTEMPTS,
): { pending: number; failed: number } {
  let pending = 0;
  let failed = 0;
  for (const mutation of mutations) {
    if (!isOfflineMutationForScope(mutation, scope)) continue;
    if ((mutation.attempts ?? 0) >= maxAttempts) failed += 1;
    else pending += 1;
  }
  return { pending, failed };
}

export function resetExhaustedOfflineMutations(
  mutations: readonly StoredOfflineMutation[],
  scope: string,
  maxAttempts = OFFLINE_MUTATION_MAX_ATTEMPTS,
): { mutations: StoredOfflineMutation[]; reset: number } {
  let reset = 0;
  const next = mutations.map((mutation) => {
    if (
      !isOfflineMutationForScope(mutation, scope) ||
      (mutation.attempts ?? 0) < maxAttempts
    ) {
      return mutation;
    }
    reset += 1;
    const { error: _error, ...rest } = mutation;
    return { ...rest, attempts: 0 } as StoredOfflineMutation;
  });
  return { mutations: next, reset };
}

export function deriveLikeOutboxState(
  mutations: readonly StoredOfflineMutation[],
  scope: string,
  maxAttempts = OFFLINE_MUTATION_MAX_ATTEMPTS,
  canonicalLikeId: (songId: string) => string = (songId) => songId,
): LikeOutboxState {
  const intents: Record<string, QueuedLikeIntent> = {};
  const baselines: Record<string, boolean> = {};
  const lockedSongIds = new Set<string>();

  for (const mutation of mutations) {
    if (mutation.type !== "like" || !isOfflineMutationForScope(mutation, scope)) continue;
    const { songId, logicalSongId, nextLiked, previousLiked, song } =
      mutation.payload;
    if (!songId || typeof nextLiked !== "boolean") continue;
    const logicalId = canonicalLikeId(logicalSongId || songId);
    lockedSongIds.add(logicalId);
    if (
      typeof previousLiked === "boolean" &&
      !Object.prototype.hasOwnProperty.call(baselines, logicalId)
    ) {
      baselines[logicalId] = previousLiked;
    }
    if ((mutation.attempts ?? 0) < maxAttempts) {
      // Array order is FIFO, so assignment makes the last active write win.
      intents[logicalId] = { songId, nextLiked, previousLiked, song };
    }
  }

  return { intents, baselines, lockedSongIds: Array.from(lockedSongIds) };
}
