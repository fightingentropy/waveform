"use client";

import { create } from "zustand";

export type PlayerSong = {
  id: string;
  title: string;
  artist: string;
  imageUrl: string;
  audioUrl: string;
};

type PlayerState = {
  queue: PlayerSong[];
  currentIndex: number; // index in queue
  currentSong: PlayerSong | null;
  isPlaying: boolean;
  volume: number; // 0..1
  isMuted: boolean;
  shuffle: boolean;
  repeatMode: "off" | "one" | "all";
  crossfadeEnabled: boolean;
  crossfadeSeconds: number; // 0..12
  setQueue: (songs: PlayerSong[], startIndex: number) => void;
  setSong: (song: PlayerSong | null) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeatMode: () => void;
  setCrossfadeEnabled: (enabled: boolean) => void;
  setCrossfadeSeconds: (seconds: number) => void;
  clearPlayer: () => void;
};

export const usePlayerStore = create<PlayerState>((set) => ({
  queue: [],
  currentIndex: -1,
  currentSong: null,
  isPlaying: false,
  volume: 0.9,
  isMuted: false,
  shuffle: false,
  repeatMode: "off",
  // Initialize deterministic values to avoid SSR/CSR hydration mismatch; rehydrate from localStorage on client mount
  crossfadeEnabled: false,
  crossfadeSeconds: 0,
  setQueue: (songs, startIndex) =>
    set(() => ({
      queue: songs,
      currentIndex: startIndex,
      currentSong: songs[startIndex] ?? null,
      isPlaying: true,
    })),
  setSong: (song) => set({ currentSong: song }),
  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  toggle: () => set((s) => ({ isPlaying: !s.isPlaying })),
  next: () =>
    set((s) => {
      if (s.queue.length === 0) return s;
      if (s.shuffle) {
        if (s.queue.length === 1) return s;
        let idx = s.currentIndex;
        while (idx === s.currentIndex) {
          idx = Math.floor(Math.random() * s.queue.length);
        }
        return {
          ...s,
          currentIndex: idx,
          currentSong: s.queue[idx],
          isPlaying: true,
        };
      }
      const atEnd = s.currentIndex >= s.queue.length - 1;
      if (atEnd) {
        if (s.repeatMode === "all") {
          return { ...s, currentIndex: 0, currentSong: s.queue[0], isPlaying: true };
        }
        // repeat one handled in PlayerBar; here stop at end for off
        return s;
      }
      const idx = s.currentIndex + 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    }),
  previous: () =>
    set((s) => {
      if (s.queue.length === 0) return s;
      if (s.shuffle) {
        if (s.queue.length === 1) return s;
        let idx = s.currentIndex;
        while (idx === s.currentIndex) {
          idx = Math.floor(Math.random() * s.queue.length);
        }
        return {
          ...s,
          currentIndex: idx,
          currentSong: s.queue[idx],
          isPlaying: true,
        };
      }
      const atStart = s.currentIndex <= 0;
      if (atStart) {
        if (s.repeatMode === "all") {
          const idx = s.queue.length - 1;
          return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
        }
        return s;
      }
      const idx = s.currentIndex - 1;
      return { ...s, currentIndex: idx, currentSong: s.queue[idx], isPlaying: true };
    }),
  setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),
  toggleMute: () => set((s) => ({ isMuted: !s.isMuted })),
  toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),
  cycleRepeatMode: () =>
    set((s) => ({ repeatMode: s.repeatMode === "off" ? "all" : s.repeatMode === "all" ? "one" : "off" })),
  setCrossfadeEnabled: (enabled) => {
    try { if (typeof window !== "undefined") localStorage.setItem("wf_crossfade_enabled", enabled ? "1" : "0"); } catch {}
    set({ crossfadeEnabled: enabled });
  },
  setCrossfadeSeconds: (seconds) => {
    const clamped = Math.max(0, Math.min(12, seconds));
    try { if (typeof window !== "undefined") localStorage.setItem("wf_crossfade_seconds", String(clamped)); } catch {}
    set({ crossfadeSeconds: clamped });
  },
  clearPlayer: () => {
    try {
      if (typeof window !== "undefined") {
        localStorage.removeItem("wf_player_state");
      }
    } catch {}
    set({
      queue: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
    });
  },
}));


