export type DiscoverStageCoordinator<T> = (
  key: string,
  findReusable: () => Promise<T | null>,
  materialize: () => Promise<T | null>,
) => Promise<T | null>;

// Serialize staging work per logical track without blocking unrelated tracks.
// Crucially, every waiter checks for a reusable result only AFTER the previous
// request finishes. That lets a lossless keep request wait for an in-flight
// preview, see that the preview is insufficient, and then upgrade it instead of
// failing immediately as "already in flight".
export function createDiscoverStageCoordinator<T>(): DiscoverStageCoordinator<T> {
  const tails = new Map<string, Promise<void>>();

  return async (key, findReusable, materialize) => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release = () => {};
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(key, turn);

    await previous;
    try {
      const reusable = await findReusable();
      return reusable !== null ? reusable : await materialize();
    } finally {
      release();
      if (tails.get(key) === turn) tails.delete(key);
    }
  };
}
