// Tiny synchronous event bus, replacing the web app's `window.dispatchEvent` /
// CustomEvent channel (e.g. the API_AUTH_REQUIRED signal that forces a logout).
type Handler = (detail?: unknown) => void;

const listeners = new Map<string, Set<Handler>>();

export function on(event: string, handler: Handler): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}

export function emit(event: string, detail?: unknown): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of Array.from(set)) {
    try {
      handler(detail);
    } catch {
      // a misbehaving listener must not break the emit loop
    }
  }
}

export const API_AUTH_REQUIRED_EVENT = "spotify:api-auth-required";
// Fired after the API + snapshot caches are wiped, so every mounted useApiData
// hook re-pulls fresh from the server instead of waiting for a remount.
export const API_CACHE_CLEARED_EVENT = "spotify:api-cache-cleared";
// Offline outbox lifecycle. Replay events carry
// `{ scope, mutation, error? }`; changed carries `{ scope }`.
export const OFFLINE_MUTATION_REPLAY_APPLIED_EVENT = "spotify:offline-mutation-replay-applied";
export const OFFLINE_MUTATION_REPLAY_EXHAUSTED_EVENT = "spotify:offline-mutation-replay-exhausted";
export const OFFLINE_MUTATION_OUTBOX_CHANGED_EVENT = "spotify:offline-mutation-outbox-changed";
