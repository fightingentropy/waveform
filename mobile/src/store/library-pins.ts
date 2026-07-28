import { create } from "zustand";
import { impactLight } from "@/lib/haptics";
import { storage } from "@/lib/storage";

// Persisted "pin to top" state for Your Library. Holds an ordered list of the
// same item keys LibraryScreen builds ("liked", `pl-<id>`, `pod-<id>`); pinned
// items float to the top of the library list in this order, newest pin first.
// Read synchronously from MMKV at creation — like the likes/player stores — so
// pinned rows don't flash on launch. Liked Songs is pinned by default (matches
// the prior hardcoded behavior); the user can unpin it via long-press.

const PINS_KEY = "spotify_library_pins";
const DEFAULT_PINS = ["liked"];

function readPins(): string[] {
  try {
    const stored = storage.getItem(PINS_KEY);
    if (stored == null) return [...DEFAULT_PINS];
    const list = JSON.parse(stored);
    if (!Array.isArray(list)) return [...DEFAULT_PINS];
    return list.filter((k): k is string => typeof k === "string" && k.length > 0);
  } catch {
    return [...DEFAULT_PINS];
  }
}

function writePins(pinned: string[]): void {
  try {
    storage.setItem(PINS_KEY, JSON.stringify(pinned));
  } catch {}
}

type LibraryPinsState = {
  pinned: string[];
  isPinned: (key: string) => boolean;
  togglePin: (key: string) => void;
  removePin: (key: string) => void;
};

export const useLibraryPinsStore = create<LibraryPinsState>((set, get) => ({
  pinned: readPins(),
  isPinned: (key) => get().pinned.includes(key),
  togglePin: (key) => {
    if (!key) return;
    void impactLight();
    const current = get().pinned;
    // Unpin if already pinned; otherwise pin to the very top (newest first).
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [key, ...current];
    writePins(next);
    set({ pinned: next });
  },
  removePin: (key) => {
    if (!key) return;
    const current = get().pinned;
    const next = current.filter((item) => item !== key);
    if (next.length === current.length) return;
    writePins(next);
    set({ pinned: next });
  },
}));
