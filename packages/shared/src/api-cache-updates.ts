type ApiCacheUpdateListener = (data: unknown) => void;

// useApiData hooks keep their own React state so screens can retain previous
// data while a new URL loads. Cache patches therefore need a small notification
// channel as well as updating the cache Map; otherwise an already-mounted screen
// only sees the new value after an unrelated rerender or remount.
const listeners = new Map<string, Set<ApiCacheUpdateListener>>();

export function subscribeApiCacheUpdate<T>(
  url: string,
  listener: (data: T) => void,
): () => void {
  const wrapped: ApiCacheUpdateListener = (data) => listener(data as T);
  let urlListeners = listeners.get(url);
  if (!urlListeners) {
    urlListeners = new Set();
    listeners.set(url, urlListeners);
  }
  urlListeners.add(wrapped);

  return () => {
    urlListeners?.delete(wrapped);
    if (urlListeners?.size === 0) listeners.delete(url);
  };
}

export function publishApiCacheUpdate<T>(url: string, data: T): void {
  const urlListeners = listeners.get(url);
  if (!urlListeners) return;
  for (const listener of Array.from(urlListeners)) {
    try {
      listener(data);
    } catch {
      // One stale or misbehaving consumer must not prevent other mounted
      // screens from receiving the same cache update.
    }
  }
}
