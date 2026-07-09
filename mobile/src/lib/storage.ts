import { MMKV } from "react-native-mmkv";

// Synchronous key-value store. The ported Zustand stores (player/likes) read
// their persisted settings at creation time, exactly like the web app read
// `localStorage` synchronously — MMKV gives us that without a hydration flash.
// Expo Router evaluates modules during static web rendering, where MMKV cannot
// access browser storage yet. Native runtimes and hydrated web pages still get
// the synchronous store; the server-render pass sees an empty, read-only facade.
const mmkv = typeof window === "undefined" ? null : new MMKV({ id: "spotify-app" });

// localStorage-compatible facade so the ported stores keep their try/catch
// getItem/setItem/removeItem call sites verbatim.
export const storage = {
  getItem(key: string): string | null {
    const value = mmkv?.getString(key);
    return value === undefined ? null : value;
  },
  setItem(key: string, value: string): void {
    mmkv?.set(key, value);
  },
  removeItem(key: string): void {
    mmkv?.delete(key);
  },
  // MMKV exposes a synchronous key list; used to clear snapshot caches by prefix.
  getAllKeys(): string[] {
    return mmkv?.getAllKeys() ?? [];
  },
};
