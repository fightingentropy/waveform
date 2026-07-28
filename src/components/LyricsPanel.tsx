"use client";

import { useEffect, useMemo, useRef } from "react";
import { activeLyricIndex } from "@/lib/lrc";
import type { LyricsState } from "@/lib/credits";
import { cn } from "@/lib/utils";

// Highlight slightly ahead of the audio clock so the line lands on the beat
// instead of trailing it (timeupdate ticks at ~4Hz).
const SYNC_LOOKAHEAD_MS = 250;
// How long after the user scrolls/touches before auto-centering resumes.
const USER_SCROLL_HOLD_MS = 2_600;

type LyricsPanelProps = {
  lyricsState: LyricsState;
  currentTime: number;
  onSeek?: (seconds: number) => void;
  size?: "lg" | "sm";
  className?: string;
};

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Spotify-style lyrics: synced files highlight the line being sung and keep it
// centered (pausing while the user explores); plain files render as scrollable
// text. Tapping a synced line seeks to it.
export function LyricsPanel({ lyricsState, currentTime, onSeek, size = "lg", className }: LyricsPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const userScrollUntilRef = useRef(0);
  const scrollHoldTimeoutRef = useRef<number | null>(null);

  const synced = lyricsState.status === "ready" ? lyricsState.parsed?.synced ?? null : null;
  const plain = lyricsState.status === "ready" ? lyricsState.parsed?.plain ?? lyricsState.text : "";

  const activeIndex = useMemo(
    () => (synced ? activeLyricIndex(synced, currentTime * 1000 + SYNC_LOOKAHEAD_MS) : -1),
    [synced, currentTime],
  );

  const markUserScroll = () => {
    userScrollUntilRef.current = Date.now() + USER_SCROLL_HOLD_MS;
    if (scrollHoldTimeoutRef.current != null) window.clearTimeout(scrollHoldTimeoutRef.current);
    scrollHoldTimeoutRef.current = window.setTimeout(() => {
      scrollHoldTimeoutRef.current = null;
      userScrollUntilRef.current = 0;
    }, USER_SCROLL_HOLD_MS);
  };

  useEffect(() => {
    return () => {
      if (scrollHoldTimeoutRef.current != null) window.clearTimeout(scrollHoldTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (activeIndex < 0) return;
    if (Date.now() < userScrollUntilRef.current) return;
    const container = containerRef.current;
    const line = lineRefs.current[activeIndex];
    if (!container || !line) return;
    const target = line.offsetTop - container.clientHeight / 2 + line.offsetHeight / 2;
    // Smooth scrolling never progresses while the document is hidden (the
    // scroll animation clock is paused), so jump instantly there.
    const documentHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    container.scrollTo({
      top: Math.max(0, target),
      behavior: prefersReducedMotion() || documentHidden ? "auto" : "smooth",
    });
  }, [activeIndex]);

  const lineSize =
    size === "lg"
      ? "text-[21px] leading-[1.4] sm:text-[23px]"
      : "text-[15px] leading-[1.45]";

  let body;
  if (lyricsState.status === "loading") {
    body = (
      <div className="flex flex-col gap-3 p-6">
        {[0.9, 0.7, 0.8, 0.55, 0.75].map((width, index) => (
          <div key={index} className="wf-skeleton h-5 rounded" style={{ width: `${width * 100}%` }} />
        ))}
      </div>
    );
  } else if (lyricsState.status === "error") {
    body = <div className="p-6 text-white/70">Unable to load lyrics.</div>;
  } else if (lyricsState.status !== "ready" || (!synced && !plain.trim())) {
    body = <div className="p-6 text-white/70">No lyrics available for this song.</div>;
  } else if (synced) {
    body = (
      <div className="flex flex-col items-start gap-1 px-5 pb-[55%] pt-[35%] sm:px-6">
        {synced.map((line, index) => (
          <button
            key={`${line.timeMs}-${index}`}
            ref={(node) => {
              lineRefs.current[index] = node;
            }}
            type="button"
            disabled={!onSeek}
            onClick={() => {
              if (!onSeek) return;
              // Let the highlight follow the seek immediately instead of
              // waiting out the user-scroll hold from this tap.
              userScrollUntilRef.current = 0;
              onSeek(line.timeMs / 1000);
            }}
            className={cn(
              "rounded-md py-1.5 text-left font-bold transition-colors duration-200",
              lineSize,
              index === activeIndex ? "text-white" : "text-white/[0.42]",
              onSeek && "cursor-pointer hover:text-white/80 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50",
            )}
          >
            {line.text || "♪"}
          </button>
        ))}
      </div>
    );
  } else {
    body = (
      <div className={cn("whitespace-pre-wrap px-5 py-6 font-semibold text-white/85 sm:px-6", lineSize)}>
        {plain}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onWheel={markUserScroll}
      onTouchMove={markUserScroll}
      onPointerDown={markUserScroll}
      className={cn(
        "relative overflow-y-auto overscroll-contain rounded-2xl border border-white/[0.08] bg-[#0c0c0d]",
        className,
      )}
    >
      {body}
    </div>
  );
}
