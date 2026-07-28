"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import { createPortal } from "react-dom";
import { Heart, ListEnd, ListStart, MoreHorizontal } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import type { PlayerSong } from "@/types/player";
import { cn } from "@/lib/utils";
import { CoverImage } from "@/components/CoverImage";
import { useModalDialogFocus } from "@/lib/use-modal-dialog";

type TrackActionsButtonProps = {
  song: PlayerSong;
  liked?: boolean;
  likePending?: boolean;
  canLike?: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  // Gates the "Play next" + "Add to queue" items.
  showQueue?: boolean;
  // Gates the "Save to / Remove from Liked Songs" item.
  showLike?: boolean;
  // Styling for the trigger button — differs between list rows and grid cards.
  className?: string;
  iconSize?: number;
};

const SHEET_TRANSITION_MS = 260;

export function TrackActionsButton({
  song,
  liked = false,
  likePending = false,
  canLike = false,
  onToggleLike,
  showQueue = true,
  showLike = true,
  className,
  iconSize = 18,
}: TrackActionsButtonProps) {
  const [open, setOpen] = useState(false);
  const hasLikeAction = showLike && !!onToggleLike;
  const hasQueueActions = showQueue;

  const handleOpen = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setOpen(true);
  }, []);

  // Nothing to surface → don't render a dead trigger.
  if (!hasLikeAction && !hasQueueActions) return null;

  return (
    <>
      <button
        type="button"
        aria-label={`More options for ${song.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="More"
        onClick={handleOpen}
        className={cn(
          "wf-control-button grid shrink-0 place-items-center rounded-full transition focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
          className,
        )}
      >
        <MoreHorizontal size={iconSize} />
      </button>

      {open ? (
        <TrackActionsSheet
          song={song}
          liked={liked}
          likePending={likePending}
          canLike={canLike}
          onToggleLike={onToggleLike}
          showQueue={hasQueueActions}
          showLike={hasLikeAction}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

type TrackActionsSheetProps = {
  song: PlayerSong;
  liked: boolean;
  likePending: boolean;
  canLike: boolean;
  onToggleLike?: (songId: string, nextLiked: boolean) => void | Promise<void>;
  showQueue: boolean;
  showLike: boolean;
  onClose: () => void;
};

function TrackActionsSheet({
  song,
  liked,
  likePending,
  canLike,
  onToggleLike,
  showQueue,
  showLike,
  onClose,
}: TrackActionsSheetProps) {
  const addToQueue = usePlayerStore((state) => state.addToQueue);
  const playNext = usePlayerStore((state) => state.playNext);
  const displaySong = song;

  const panelRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);
  const touchStartYRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);

  // Drive the entrance: mount off-screen, then flip on the next frame so the
  // slide-up transition runs.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useModalDialogFocus(true, panelRef);

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setVisible(false);
    window.setTimeout(onClose, SHEET_TRANSITION_MS);
  }, [onClose]);

  // Escape to close.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  // Lock background scroll while the sheet is open. Mirror QueueSheet's guard so
  // a now-playing/queue sheet underneath keeps the lock when this one closes.
  useEffect(() => {
    document.body.classList.add("wf-now-playing-open");
    return () => {
      if (document.querySelector('.wf-now-playing-panel[data-open="true"]')) return;
      document.body.classList.remove("wf-now-playing-open");
    };
  }, []);

  const runAction = useCallback(
    (action: () => void) => {
      action();
      close();
    },
    [close],
  );

  const handleTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchEnd = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const startY = touchStartYRef.current;
      const endY = event.changedTouches[0]?.clientY;
      touchStartYRef.current = null;
      if (startY == null || endY == null) return;
      if (endY - startY > 60) close();
    },
    [close],
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[80]" role="presentation">
      <button
        type="button"
        aria-label="Close menu"
        onClick={(event) => {
          event.stopPropagation();
          close();
        }}
        className={cn(
          "absolute inset-0 bg-black/60 transition-opacity duration-300",
          visible ? "opacity-100" : "opacity-0",
        )}
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Actions for ${displaySong.title}`}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={cn(
          "absolute inset-x-0 bottom-0 mx-auto w-full max-w-md",
          "rounded-t-3xl border-t border-white/10 bg-background text-white",
          "shadow-[0_-16px_50px_rgba(0,0,0,0.55)] outline-none",
          "pb-[calc(env(safe-area-inset-bottom)+0.5rem)]",
          "transition-transform duration-[260ms] ease-out will-change-transform motion-reduce:transition-none",
          visible ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div aria-hidden className="mx-auto mt-2.5 h-1 w-9 rounded-full bg-white/25" />

        <div className="flex items-center gap-3 px-5 pb-4 pt-3">
          <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded">
            <CoverImage
              src={displaySong.imageUrl}
              networkSrc={displaySong.networkImageUrl}
              alt={displaySong.title}
              fill
              sizes="48px"
              className="wf-song-cover object-cover"
              loading="lazy"
            />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{displaySong.title}</div>
            <div className="truncate text-xs text-white/60">{displaySong.artist}</div>
          </div>
        </div>

        <div className="mx-5 border-t border-white/10" />

        <div className="px-2 py-2">
          {showQueue ? (
            <>
              <ActionRow
                icon={<ListStart size={20} />}
                label="Play next"
                onClick={() => runAction(() => playNext(song))}
              />
              <ActionRow
                icon={<ListEnd size={20} />}
                label="Add to queue"
                onClick={() => runAction(() => addToQueue(song))}
              />
            </>
          ) : null}

          {showLike && onToggleLike ? (
            <ActionRow
              icon={
                <Heart
                  size={20}
                  className={cn(liked ? "fill-white text-white" : undefined)}
                />
              }
              label={
                !canLike
                  ? "Save to Liked Songs"
                  : liked
                    ? "Remove from Liked Songs"
                    : "Save to Liked Songs"
              }
              disabled={likePending}
              onClick={() =>
                runAction(() => {
                  void onToggleLike(song.id, !liked);
                })
              }
            />
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function ActionRow({
  icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-4 rounded-xl px-3 py-3 text-left text-[15px] font-medium text-white/90",
        "transition hover:bg-white/10 active:bg-white/10 focus:outline-none focus-visible:bg-white/10",
        "touch-manipulation disabled:cursor-wait disabled:opacity-60",
      )}
    >
      <span className="grid h-6 w-6 shrink-0 place-items-center text-white/70">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}
