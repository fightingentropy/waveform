import { describe, expect, test } from "bun:test";
import { createDiscoverStageCoordinator } from "../src/server/discover-stage-coordinator";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Staged = { quality: "preview" | "lossless" };

describe("Discover stage coordination", () => {
  test("waits for an in-flight preview and then upgrades it for a keep request", async () => {
    const coordinate = createDiscoverStageCoordinator<Staged>();
    const previewStarted = deferred<void>();
    const releasePreview = deferred<void>();
    let staged: Staged | null = null;
    let losslessStarted = false;

    const preview = coordinate(
      "track-1",
      async () => staged,
      async () => {
        previewStarted.resolve();
        await releasePreview.promise;
        staged = { quality: "preview" };
        return staged;
      },
    );
    await previewStarted.promise;

    const lossless = coordinate(
      "track-1",
      async () => (staged?.quality === "lossless" ? staged : null),
      async () => {
        losslessStarted = true;
        staged = { quality: "lossless" };
        return staged;
      },
    );

    await Promise.resolve();
    expect(losslessStarted).toBe(false);
    releasePreview.resolve();

    expect(await preview).toEqual({ quality: "preview" });
    expect(await lossless).toEqual({ quality: "lossless" });
    expect(losslessStarted).toBe(true);
  });

  test("reuses the first result for duplicate same-quality requests", async () => {
    const coordinate = createDiscoverStageCoordinator<Staged>();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let staged: Staged | null = null;
    let materializations = 0;

    const materialize = async () => {
      materializations += 1;
      if (materializations === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      staged = { quality: "preview" as const };
      return staged;
    };
    const first = coordinate("track-1", async () => staged, materialize);
    await firstStarted.promise;
    const second = coordinate("track-1", async () => staged, materialize);
    releaseFirst.resolve();

    expect(await first).toEqual({ quality: "preview" });
    expect(await second).toEqual({ quality: "preview" });
    expect(materializations).toBe(1);
  });

  test("releases the track after a failed materialization", async () => {
    const coordinate = createDiscoverStageCoordinator<Staged>();

    await expect(
      coordinate("track-1", async () => null, async () => {
        throw new Error("preview failed");
      }),
    ).rejects.toThrow("preview failed");

    await expect(
      coordinate("track-1", async () => null, async () => ({ quality: "lossless" })),
    ).resolves.toEqual({ quality: "lossless" });
  });
});
