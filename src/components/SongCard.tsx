"use client";

import { memo, useCallback } from "react";
import { CoverImage } from "@/components/CoverImage";
import { warmPlaybackSong } from "@/client/playback-warm";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { Pause, Play } from "lucide-react";
import { TrackActionsButton } from "@/components/TrackActionsMenu";

type SongCardProps = {
  song: PlayerSong;
  songIndex?: number;
  onPlayAt?: (index: number) => void;
  variant?: "default" | "playlist";
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  hideIfUnliked?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  showLike?: boolean;
  showQueue?: boolean;
  priority?: boolean;
};

const SongCardComponent = function SongCard({
  song,
  songIndex,
  onPlayAt,
  variant = "default",
  liked = false,
  likePending = false,
  canLike = false,
  hideIfUnliked = false,
  onToggleLike,
  showLike = true,
  showQueue = true,
  priority = false,
}: SongCardProps) {
  // Optimized selector - only subscribes to necessary state changes
  const setSong = usePlayerStore((state) => state.setSong);
  const play = usePlayerStore((state) => state.play);
  const pause = usePlayerStore((state) => state.pause);
  const isActive = usePlayerStore(useCallback((state) => state.currentSong?.id === song.id, [song.id]));
  const isActiveAndPlaying = usePlayerStore(
    useCallback((state) => state.currentSong?.id === song.id && state.isPlaying, [song.id]),
  );

  const handlePlay = useCallback(() => {
    if (isActive) {
      if (isActiveAndPlaying) pause();
      else {
        requestImmediatePlayback(song);
        play();
      }
      return;
    }
    if (typeof songIndex === "number" && onPlayAt) {
      requestImmediatePlayback(song);
      onPlayAt(songIndex);
    } else {
      requestImmediatePlayback(song);
      setSong(song);
      play();
    }
  }, [isActive, isActiveAndPlaying, onPlayAt, pause, play, setSong, song, songIndex]);

  if (hideIfUnliked && !liked) return null;

  if (variant === "playlist") {
    return (
      <div
        onPointerEnter={() => warmPlaybackSong(song, true)}
        className="wf-song-card group relative min-w-0"
      >
        <div
          className={cn(
            "relative aspect-square overflow-hidden rounded-[10px] bg-[#0c0c0d]",
            isActive && "ring-1 ring-white/40",
          )}
        >
          <button
            type="button"
            aria-label={isActiveAndPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
            aria-pressed={isActiveAndPlaying}
            onClick={handlePlay}
            onFocus={() => warmPlaybackSong(song, true)}
            className="absolute inset-0 z-10 cursor-pointer rounded-[10px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          />
          <CoverImage
            src={song.imageUrl}
            networkSrc={song.networkImageUrl}
            alt={song.title}
            fill
            sizes="(max-width: 640px) 44vw, 190px"
            className="wf-song-cover object-cover"
            priority={priority}
            loading={priority ? "eager" : "lazy"}
          />
        </div>

        <div className="mt-2 flex min-w-0 items-start gap-1">
          <button
            type="button"
            aria-label={isActiveAndPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
            aria-pressed={isActiveAndPlaying}
            onClick={handlePlay}
            onFocus={() => warmPlaybackSong(song, true)}
            className="min-w-0 flex-1 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <span className={cn("block truncate text-[14px] leading-5 text-[#f2f2f2]", isActive ? "font-semibold" : "font-medium")}>
              {song.title}
            </span>
            <span className="block truncate text-xs leading-5 text-white/55">
              {song.artist || "Unknown Artist"}
            </span>
          </button>
          {isActive ? (
            <span
              aria-hidden
              className="wf-control-button grid h-8 w-8 shrink-0 place-items-center rounded-full text-white"
            >
              {isActiveAndPlaying ? (
                <Pause size={15} fill="currentColor" />
              ) : (
                <Play size={15} fill="currentColor" className="translate-x-px" />
              )}
            </span>
          ) : null}
          <TrackActionsButton
            song={song}
            liked={liked}
            likePending={likePending}
            canLike={canLike}
            onToggleLike={onToggleLike}
            showLike={showLike}
            showQueue={showQueue}
            className="h-8 w-8 text-white/60 hover:bg-white/[0.08] hover:text-white"
            iconSize={17}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      onPointerEnter={() => warmPlaybackSong(song, true)}
      className={cn(
        "wf-song-card wf-pressable group relative aspect-square overflow-hidden rounded-[10px] bg-[#0c0c0d]",
        isActive && "ring-1 ring-white/30"
      )}
    >
      <button
        type="button"
        aria-label={isActiveAndPlaying ? `Pause ${song.title}` : `Play ${song.title}`}
        aria-pressed={isActiveAndPlaying}
        onClick={handlePlay}
        onFocus={() => warmPlaybackSong(song, true)}
        className="absolute inset-0 z-10 cursor-pointer rounded-[10px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      />
      <CoverImage
        src={song.imageUrl}
        networkSrc={song.networkImageUrl}
        alt={song.title}
        fill
        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 33vw, 200px"
        className="wf-song-cover object-cover"
        priority={priority}
        loading={priority ? "eager" : "lazy"}
      />
      <div className="absolute inset-x-0 bottom-0 h-16 bg-black/[0.76]" />

      <TrackActionsButton
        song={song}
        liked={liked}
        likePending={likePending}
        canLike={canLike}
        onToggleLike={onToggleLike}
        showLike={showLike}
        showQueue={showQueue}
        className="absolute right-2 top-2 z-30 h-9 w-9 text-white/90 bg-black/40 backdrop-blur hover:bg-black/60"
      />

      <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-20 flex items-end justify-between gap-2">
        <div className="text-left min-w-0 flex-1">
          <div className="text-white font-medium drop-shadow truncate">{song.title}</div>
          <div className="text-white/80 text-xs drop-shadow truncate">{song.artist}</div>
        </div>
        <div
          className={cn(
            "transition-opacity shrink-0",
            isActive
              ? "opacity-100"
              : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          )}
        >
          <div className="wf-control-button grid h-10 w-10 place-items-center text-white">
            {isActiveAndPlaying ? (
              <Pause size={18} fill="currentColor" />
            ) : (
              <Play size={18} fill="currentColor" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Memoize to prevent re-renders when parent re-renders
export const SongCard = memo(SongCardComponent, (prevProps, nextProps) => {
  // Custom comparison for optimal re-render prevention
  return (
    prevProps.song === nextProps.song &&
    prevProps.songIndex === nextProps.songIndex &&
    prevProps.variant === nextProps.variant &&
    prevProps.liked === nextProps.liked &&
    prevProps.likePending === nextProps.likePending &&
    prevProps.canLike === nextProps.canLike &&
    prevProps.hideIfUnliked === nextProps.hideIfUnliked &&
    prevProps.showLike === nextProps.showLike &&
    prevProps.showQueue === nextProps.showQueue &&
    prevProps.priority === nextProps.priority &&
    prevProps.onPlayAt === nextProps.onPlayAt &&
    prevProps.onToggleLike === nextProps.onToggleLike
  );
});
