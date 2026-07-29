import type { ReactNode } from "react";
import { create } from "zustand";
import type { PlayerSong } from "@/types/player";

// UI state for the three global bottom sheets (Now Playing, Queue, Track Actions)
// plus the sleep-timer sheet and the right profile drawer. Kept separate from the
// player store.
export type TrackActionsTarget = {
  song: PlayerSong;
  canLike: boolean;
  showLike: boolean;
  // When the song is opened from an editable playlist, offer "Remove from this
  // playlist". Carried so the global TrackActionsMenu can act without prop-drilling.
  playlist?: { id: string; name: string };
} | null;

// A generic name-input dialog reused for Create playlist + Rename playlist.
export type NamePromptTarget = {
  title: string;
  initialValue: string;
  confirmLabel: string;
  placeholder?: string;
  onSubmit: (name: string) => void;
} | null;

// Long-press actions for a Your Library row. `cover` is the same size-aware
// render fn LibraryScreen builds, reused for the sheet's header art. Playlist
// metadata is only present for real playlist entries; shortcuts and podcasts
// remain pin-only.
export type LibraryActionsTarget = {
  key: string;
  title: string;
  subtitle: string;
  cover: (size: number) => ReactNode;
  playlist?: {
    id: string;
    canDelete: boolean;
  };
} | null;

// Optional collection context when the Listening Modes sheet is opened from a
// collection header (Liked / a playlist) instead of the Now Playing transport.
// Lets Smart Shuffle enable for that collection even before it is the playing
// queue. Same shape as the player store's queueContext.
export type ListeningModesContext = {
  playlistId?: string;
  editable?: boolean;
  kind?: "liked" | "playlist";
} | null;

type UiState = {
  nowPlayingOpen: boolean;
  queueOpen: boolean;
  listeningModesOpen: boolean;
  // Collection passed when the modes sheet is opened from a header (or null when
  // opened from Now Playing, where the sheet falls back to the playing queue).
  listeningModesContext: ListeningModesContext;
  sleepTimerOpen: boolean;
  profileMenuOpen: boolean;
  createMenuOpen: boolean;
  librarySortOpen: boolean;
  // The song collection whose sort sheet is open (e.g. "liked", "playlist:<id>",
  // "downloads"), or null when closed. Carried so the global SongSortMenu edits
  // the right collection's persisted order.
  songSortContext: string | null;
  trackActions: TrackActionsTarget;
  libraryActions: LibraryActionsTarget;
  // The song being added to a playlist (drives AddToPlaylistSheet), or null.
  addToPlaylistSong: PlayerSong | null;
  namePrompt: NamePromptTarget;
  openNowPlaying: () => void;
  closeNowPlaying: () => void;
  openQueue: () => void;
  closeQueue: () => void;
  openListeningModes: (context?: ListeningModesContext) => void;
  closeListeningModes: () => void;
  openSleepTimer: () => void;
  closeSleepTimer: () => void;
  openProfileMenu: () => void;
  closeProfileMenu: () => void;
  openCreateMenu: () => void;
  closeCreateMenu: () => void;
  openLibrarySort: () => void;
  closeLibrarySort: () => void;
  openSongSort: (context: string) => void;
  closeSongSort: () => void;
  openTrackActions: (target: NonNullable<TrackActionsTarget>) => void;
  closeTrackActions: () => void;
  openLibraryActions: (target: NonNullable<LibraryActionsTarget>) => void;
  closeLibraryActions: () => void;
  openAddToPlaylist: (song: PlayerSong) => void;
  closeAddToPlaylist: () => void;
  openNamePrompt: (target: NonNullable<NamePromptTarget>) => void;
  closeNamePrompt: () => void;
};

export const useUiStore = create<UiState>((set) => ({
  nowPlayingOpen: false,
  queueOpen: false,
  listeningModesOpen: false,
  listeningModesContext: null,
  sleepTimerOpen: false,
  profileMenuOpen: false,
  createMenuOpen: false,
  librarySortOpen: false,
  songSortContext: null,
  trackActions: null,
  libraryActions: null,
  addToPlaylistSong: null,
  namePrompt: null,
  openNowPlaying: () => set({ nowPlayingOpen: true }),
  closeNowPlaying: () => set({ nowPlayingOpen: false }),
  openQueue: () => set({ queueOpen: true }),
  closeQueue: () => set({ queueOpen: false }),
  openListeningModes: (context) => set({ listeningModesOpen: true, listeningModesContext: context ?? null }),
  closeListeningModes: () => set({ listeningModesOpen: false, listeningModesContext: null }),
  openSleepTimer: () => set({ sleepTimerOpen: true }),
  closeSleepTimer: () => set({ sleepTimerOpen: false }),
  openProfileMenu: () => set({ profileMenuOpen: true }),
  closeProfileMenu: () => set({ profileMenuOpen: false }),
  openCreateMenu: () => set({ createMenuOpen: true }),
  closeCreateMenu: () => set({ createMenuOpen: false }),
  openLibrarySort: () => set({ librarySortOpen: true }),
  closeLibrarySort: () => set({ librarySortOpen: false }),
  openSongSort: (context) => set({ songSortContext: context }),
  closeSongSort: () => set({ songSortContext: null }),
  openTrackActions: (target) => set({ trackActions: target }),
  closeTrackActions: () => set({ trackActions: null }),
  openLibraryActions: (target) => set({ libraryActions: target }),
  closeLibraryActions: () => set({ libraryActions: null }),
  openAddToPlaylist: (song) => set({ addToPlaylistSong: song }),
  closeAddToPlaylist: () => set({ addToPlaylistSong: null }),
  openNamePrompt: (target) => set({ namePrompt: target }),
  closeNamePrompt: () => set({ namePrompt: null }),
}));
