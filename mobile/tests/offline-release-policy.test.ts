import { describe, expect, test } from "bun:test";
import {
  offlineDownloadKey,
  planQueuedDownloads,
  type OfflineDownloadRecord,
} from "../src/lib/offline-download-queue";
import {
  OFFLINE_MUTATION_MAX_ATTEMPTS,
  OFFLINE_MUTATION_TIMEOUT_MS,
  createStoredOfflineMutation,
  deriveLikeOutboxState,
  isOfflineMutationReplayCurrent,
  offlineMutationCounts,
  planOfflineMutationFailure,
  replayMutationsFifo,
  resetExhaustedOfflineMutations,
  settleAppliedOfflineMutation,
  shouldPublishOfflineMutationCounts,
  type StoredOfflineMutation,
} from "../src/lib/offline-mutation-policy";
import {
  applyQueuedLikeIntents,
  protectLikeBaselines,
  updateAuthoritativeLikedIds,
} from "../src/lib/like-intent-overlay";
import type { PlayerSong } from "../src/types/player";

function song(id: string, title = id): PlayerSong {
  return {
    id,
    title,
    artist: "Artist",
    imageUrl: "",
    audioUrl: `/api/files/${id}.flac`,
    source: "server",
  };
}

describe("offline mutation FIFO policy", () => {
  test("a retryable head failure stops later last-write mutations", async () => {
    const replayed: string[] = [];
    await replayMutationsFifo(["like", "unlike"], async (mutation) => {
      replayed.push(mutation);
      const failure = planOfflineMutationFailure({
        attempts: 0,
        online: true,
        status: 503,
      });
      return failure.stop ? "stop" : "continue";
    });

    expect(replayed).toEqual(["like"]);
  });

  test("auth and connectivity waits retain their attempt count", () => {
    expect(planOfflineMutationFailure({ attempts: 2, online: true, status: 401 })).toEqual({
      kind: "auth-required",
      nextAttempts: 2,
      stop: true,
    });
    expect(planOfflineMutationFailure({ attempts: 2, online: false })).toEqual({
      kind: "offline",
      nextAttempts: 2,
      stop: true,
    });
  });

  test("online failures block while retryable, then release the FIFO after exhaustion", () => {
    expect(
      planOfflineMutationFailure({
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS - 2,
        online: true,
        status: 503,
      }),
    ).toEqual({
      kind: "retry-retained",
      nextAttempts: OFFLINE_MUTATION_MAX_ATTEMPTS - 1,
      stop: true,
    });
    expect(
      planOfflineMutationFailure({
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS - 1,
        online: true,
        status: 503,
      }),
    ).toEqual({
      kind: "retry-exhausted",
      nextAttempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      stop: false,
    });
  });

  test("mutation requests use a finite interactive deadline", () => {
    expect(OFFLINE_MUTATION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(OFFLINE_MUTATION_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("persisted like intent overlay", () => {
  test("keeps an optimistic queued like above a stale cached GET", () => {
    const queued = createStoredOfflineMutation(
      {
        type: "like",
        payload: { songId: "song-1", nextLiked: true, previousLiked: false },
      },
      "user-a",
      1,
    );
    const outbox = deriveLikeOutboxState([queued], "user-a");

    // The GET contains the optimistic cache patch, not an authoritative server
    // confirmation. Restore the persisted baseline, then reapply the intent.
    const raw = protectLikeBaselines(["song-1"], [], outbox);
    const visible = applyQueuedLikeIntents({}, outbox.intents);

    expect(raw).toEqual([]);
    expect(visible).toEqual({ "song-1": true });
  });

  test("queued unlike survives relaunch and rolls back only when exhausted", () => {
    const queued = createStoredOfflineMutation(
      {
        type: "like",
        payload: { songId: "song-1", nextLiked: false, previousLiked: true },
      },
      "user-a",
      1,
    );
    const active = deriveLikeOutboxState([queued], "user-a");
    const activeRaw = protectLikeBaselines([], [], active);
    const activeVisible = applyQueuedLikeIntents(
      Object.fromEntries(activeRaw.map((id) => [id, true])),
      active.intents,
    );
    expect(activeRaw).toEqual(["song-1"]);
    expect(activeVisible).toEqual({});

    const exhausted = {
      ...queued,
      attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      error: "server unavailable",
    };
    const failed = deriveLikeOutboxState([exhausted], "user-a");
    const rollbackRaw = protectLikeBaselines([], [], failed);
    const rollbackVisible = applyQueuedLikeIntents(
      Object.fromEntries(rollbackRaw.map((id) => [id, true])),
      failed.intents,
    );
    expect(failed.intents).toEqual({});
    expect(rollbackVisible).toEqual({ "song-1": true });
  });

  test("applied replay advances the authoritative baseline", () => {
    expect(updateAuthoritativeLikedIds([], "copy", true, "canonical")).toEqual([
      "canonical",
    ]);
    expect(
      updateAuthoritativeLikedIds(["copy", "canonical"], "copy", false, "canonical"),
    ).toEqual([]);
    expect(
      updateAuthoritativeLikedIds(
        ["copy-a", "copy-b"],
        "copy-b",
        false,
        "song-1",
        (id) => (id.startsWith("copy-") ? "song-1" : id),
      ),
    ).toEqual([]);
  });

  test("canonical copies share the first persisted rollback baseline", () => {
    const canonical = (id: string) =>
      id === "copy-a" || id === "copy-b" ? "song-1" : id;
    const queue: StoredOfflineMutation[] = [
      {
        type: "like",
        payload: {
          songId: "copy-a",
          nextLiked: true,
          previousLiked: false,
        },
        scope: "user-a",
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
      {
        type: "like",
        payload: {
          songId: "copy-b",
          nextLiked: false,
          previousLiked: true,
        },
        scope: "user-a",
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
    ];
    const outbox = deriveLikeOutboxState(
      queue,
      "user-a",
      OFFLINE_MUTATION_MAX_ATTEMPTS,
      canonical,
    );
    expect(outbox.lockedSongIds).toEqual(["song-1"]);
    expect(outbox.baselines).toEqual({ "song-1": false });
    expect(protectLikeBaselines(["copy-a", "copy-b"], [], outbox, canonical)).toEqual(
      [],
    );
  });
});

describe("offline mutation dead letters and account scope", () => {
  test("a later applied intent discards the older exhausted intent it supersedes", () => {
    const queue: StoredOfflineMutation[] = [
      {
        type: "like",
        payload: { songId: "song-1", nextLiked: true, previousLiked: false },
        scope: "user-a",
        queuedAt: 1,
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
      {
        type: "like",
        payload: { songId: "song-1", nextLiked: false, previousLiked: true },
        scope: "user-a",
        queuedAt: 2,
        attempts: 0,
      },
    ];

    const settled = settleAppliedOfflineMutation(queue, 1);
    expect(settled.discardedFailures).toBe(1);
    expect(settled.mutations).toEqual([]);
    expect(resetExhaustedOfflineMutations(settled.mutations, "user-a").reset).toBe(0);
  });

  test("canonical copy success supersedes an older exhausted copy intent", () => {
    const canonical = (id: string) =>
      id === "copy-a" || id === "copy-b" ? "song-1" : id;
    const queue: StoredOfflineMutation[] = [
      {
        type: "like",
        payload: { songId: "copy-a", nextLiked: true, previousLiked: false },
        scope: "user-a",
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
      {
        type: "like",
        payload: { songId: "copy-b", nextLiked: false, previousLiked: true },
        scope: "user-a",
        attempts: 0,
      },
    ];
    expect(
      settleAppliedOfflineMutation(
        queue,
        1,
        OFFLINE_MUTATION_MAX_ATTEMPTS,
        "user-a",
        canonical,
      ),
    ).toMatchObject({ mutations: [], discardedFailures: 1 });
  });

  test("an applied mutation never discards another account's dead letter", () => {
    const queue: StoredOfflineMutation[] = [
      {
        type: "like",
        payload: { songId: "song-1", nextLiked: true },
        scope: "user-a",
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
      {
        type: "like",
        payload: { songId: "song-1", nextLiked: false },
        scope: "user-b",
        attempts: 0,
      },
    ];
    const settled = settleAppliedOfflineMutation(
      queue,
      1,
      OFFLINE_MUTATION_MAX_ATTEMPTS,
      "user-b",
    );
    expect(settled.discardedFailures).toBe(0);
    expect(settled.mutations).toEqual([queue[0]]);
  });

  test("superseded cleanup is target-specific for reorder and edit mutations", () => {
    const queue: StoredOfflineMutation[] = [
      {
        type: "playlist-reorder",
        payload: { playlistId: "playlist-1", songIds: ["old"] },
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
      {
        type: "playlist-reorder",
        payload: { playlistId: "playlist-2", songIds: ["keep"] },
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
      {
        type: "playlist-reorder",
        payload: { playlistId: "playlist-1", songIds: ["new"] },
        attempts: 0,
      },
    ];
    const settled = settleAppliedOfflineMutation(queue, 2);
    expect(settled.mutations).toHaveLength(1);
    expect(settled.mutations[0]).toMatchObject({
      type: "playlist-reorder",
      payload: { playlistId: "playlist-2" },
    });

    const edits: StoredOfflineMutation[] = [
      {
        type: "song-edit",
        payload: { songId: "song-1", title: "Old" },
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
      {
        type: "song-edit",
        payload: { songId: "song-1", title: "Final" },
        attempts: 0,
      },
    ];
    expect(settleAppliedOfflineMutation(edits, 1).mutations).toEqual([]);
  });

  test("dead letters remain visible and manual retry resets only the active account", () => {
    const queue: StoredOfflineMutation[] = [
      {
        type: "like",
        payload: { songId: "failed", nextLiked: true },
        scope: "user-a",
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
        error: "failed",
      },
      {
        type: "like",
        payload: { songId: "pending", nextLiked: true },
        scope: "user-a",
        attempts: 1,
      },
      {
        type: "like",
        payload: { songId: "other", nextLiked: true },
        scope: "user-b",
        attempts: OFFLINE_MUTATION_MAX_ATTEMPTS,
      },
    ];
    expect(offlineMutationCounts(queue, "user-a")).toEqual({
      pending: 1,
      failed: 1,
    });
    const reset = resetExhaustedOfflineMutations(queue, "user-a");
    expect(reset.reset).toBe(1);
    expect(offlineMutationCounts(reset.mutations, "user-a")).toEqual({
      pending: 2,
      failed: 0,
    });
    expect(offlineMutationCounts(reset.mutations, "user-b")).toEqual({
      pending: 0,
      failed: 1,
    });
  });

  test("captured enqueue scope and replay generation reject an in-flight account switch", () => {
    const capturedScope = "user-a";
    const stored = createStoredOfflineMutation(
      {
        type: "like",
        payload: { songId: "song-1", nextLiked: true },
      },
      capturedScope,
      1,
    );
    const activeScope = "user-b";

    expect(stored.scope).toBe("user-a");
    expect(offlineMutationCounts([stored], activeScope)).toEqual({
      pending: 0,
      failed: 0,
    });
    expect(shouldPublishOfflineMutationCounts(stored.scope ?? "", activeScope)).toBe(
      false,
    );
    expect(isOfflineMutationReplayCurrent("user-a", 3, "user-b", 4)).toBe(false);
    expect(isOfflineMutationReplayCurrent("user-a", 3, "user-a", 4)).toBe(false);
    expect(isOfflineMutationReplayCurrent("user-a", 3, "user-a", 3)).toBe(true);
  });
});

describe("offline download queue batch planning", () => {
  test("plans new songs with one map copy and deduplicates repeated ids", () => {
    const current: Record<string, OfflineDownloadRecord> = {};
    let timestamp = 100;
    const planned = planQueuedDownloads(
      current,
      [song("a"), song("a", "Duplicate"), song("b")],
      "liked",
      "user-1",
      () => timestamp++,
    );

    expect(current).toEqual({});
    expect(planned.changedRecords.map((record) => record.songId)).toEqual(["a", "b"]);
    expect(Object.keys(planned.records)).toEqual([
      offlineDownloadKey("user-1", "a"),
      offlineDownloadKey("user-1", "b"),
    ]);
    expect(planned.records[offlineDownloadKey("user-1", "a")].song.title).toBe("a");
  });

  test("requeues errors, merges scopes, and preserves completed assets", () => {
    const failed = song("failed", "Old metadata");
    const ready = song("ready");
    const current: Record<string, OfflineDownloadRecord> = {
      [offlineDownloadKey("user-1", failed.id)]: {
        songId: failed.id,
        accountScope: "user-1",
        scopes: ["home"],
        status: "error",
        song: failed,
        updatedAt: 1,
        error: "network",
      },
      [offlineDownloadKey("user-1", ready.id)]: {
        songId: ready.id,
        accountScope: "user-1",
        scopes: ["home"],
        status: "ready",
        song: ready,
        audioPath: "offline-media/ready/audio.flac",
        updatedAt: 1,
      },
    };

    const planned = planQueuedDownloads(
      current,
      [song("failed", "Fresh metadata"), ready],
      "liked",
      "user-1",
      () => 2,
    );
    const retried = planned.records[offlineDownloadKey("user-1", "failed")];
    const completed = planned.records[offlineDownloadKey("user-1", "ready")];

    expect(retried).toMatchObject({
      status: "queued",
      scopes: ["home", "liked"],
      song: { title: "Fresh metadata" },
      updatedAt: 2,
    });
    expect(retried.error).toBeUndefined();
    expect(completed).toMatchObject({
      status: "ready",
      scopes: ["home", "liked"],
      audioPath: "offline-media/ready/audio.flac",
    });
    expect(planned.changedRecords).toHaveLength(2);
  });

  test("returns the original map when every requested scope is already queued", () => {
    const queued = song("queued");
    const current: Record<string, OfflineDownloadRecord> = {
      [offlineDownloadKey("user-1", queued.id)]: {
        songId: queued.id,
        accountScope: "user-1",
        scopes: ["liked"],
        status: "queued",
        song: queued,
        updatedAt: 1,
      },
    };

    const planned = planQueuedDownloads(current, [queued], "liked", "user-1");
    expect(planned.records).toBe(current);
    expect(planned.changedRecords).toEqual([]);
  });
});
