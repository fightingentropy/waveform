"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, FileText, Music4, Podcast, RadioTower } from "lucide-react";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";
import { parseCredits, useLyrics } from "@/lib/credits";
import { isPodcastSong, isRadioSong } from "@/lib/player-song";
import { requestPlaybackSeek, subscribePlaybackPosition } from "@/lib/playback-position";
import { CoverImage } from "@/components/CoverImage";
import { LyricsPanel } from "@/components/LyricsPanel";

export default function NowPlayingSidebar() {
  const currentSong = usePlayerStore((state) => state.currentSong);
  const displaySong = currentSong;
  const liveStream = isRadioSong(displaySong);
  const podcastEpisode = isPodcastSong(displaySong);
  const podcastDescription = displaySong?.description?.trim() ?? "";

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("spotify_right_sidebar_collapsed") === "1",
  );
  const [showLyrics, setShowLyrics] = useState(false);
  const [playbackPosition, setPlaybackPosition] = useState(0);

  const credits = useMemo(
    () => parseCredits(displaySong?.artist || ""),
    [displaySong?.artist],
  );

  const lyricsState = useLyrics(displaySong?.id, displaySong?.lyricsUrl, showLyrics);

  useEffect(() => {
    const width = collapsed ? "4rem" : "20rem";
    document.documentElement.style.setProperty("--wf-right-sidebar-width", width);
    localStorage.setItem("spotify_right_sidebar_collapsed", collapsed ? "1" : "0");
    return () => {
      document.documentElement.style.removeProperty("--wf-right-sidebar-width");
    };
  }, [collapsed]);

  // PlayerBar owns the audio clock; follow it only while lyrics are visible
  // so the sidebar doesn't re-render 4x/second the rest of the time.
  useEffect(() => {
    if (!showLyrics || collapsed) return;
    return subscribePlaybackPosition((detail) => setPlaybackPosition(detail.currentTime));
  }, [collapsed, showLyrics]);

  return (
    <aside
      className={cn(
        "hidden lg:flex fixed top-14 bottom-[84px] right-0 z-30 border-l border-white/[0.12] bg-background text-white transition-all duration-200",
        collapsed ? "w-16" : "w-80",
      )}
    >
      <div className={cn("h-full w-full overflow-y-auto", collapsed ? "p-2" : "p-4")}>
        <div className="mb-4 flex items-center justify-between">
          {!collapsed && (
            <div className="text-[13px] uppercase tracking-wide text-white/[0.55]">
              Now Playing
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="h-8 w-8 rounded-full grid place-items-center text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white ml-auto"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>

        {collapsed ? (
          <div className="mt-6 flex flex-col items-center gap-3 text-white/[0.68]">
            <Music4 size={18} />
            <span className="[writing-mode:vertical-rl] rotate-180 text-xs tracking-wider">
              Now Playing
            </span>
          </div>
        ) : !displaySong ? (
          <div className="h-full grid place-items-center text-[15px] leading-6 text-white/[0.62] text-center px-4">
            Select a song to see now playing details.
          </div>
        ) : (
          <div className="space-y-5 pb-4">
            <CoverImage
              src={displaySong.imageUrl}
              networkSrc={displaySong.networkImageUrl}
              alt={displaySong.title}
              loading="eager"
              className="w-full aspect-square rounded-md object-cover bg-white/[0.08]"
            />

            <div>
              <div className="text-[22px] font-semibold leading-tight text-white">{displaySong.title}</div>
              <div className="text-[16px] leading-6 text-white/[0.68] mt-1">{displaySong.artist}</div>
            </div>

            {liveStream ? (
              <div className="rounded-md border border-white/[0.12] bg-white/[0.03] p-3.5">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[5px] bg-cyan-500/15 text-cyan-200">
                    <RadioTower size={18} />
                  </div>
                  <div>
                    <div className="font-medium text-[16px] text-white">Live Radio</div>
                  </div>
                </div>
              </div>
            ) : podcastEpisode ? (
              <div className="rounded-md border border-white/[0.12] bg-white/[0.03] p-3.5">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-[5px] bg-fuchsia-500/15 text-fuchsia-200">
                    <Podcast size={18} />
                  </div>
                  <div>
                    <div className="font-medium text-[16px] text-white">Podcast Episode</div>
                  </div>
                </div>
                {podcastDescription ? (
                  <p className="mt-3 line-clamp-5 text-[13px] leading-5 text-white/[0.64]">
                    {podcastDescription}
                  </p>
                ) : null}
              </div>
            ) : (
              <>
                <div className="rounded-md border border-white/[0.12] bg-white/[0.03] p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-[16px] text-white">Lyrics</div>
                    <button
                      type="button"
                      onClick={() => setShowLyrics((value) => !value)}
                      onMouseUp={(event) => event.currentTarget.blur()}
                      className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border border-white/[0.16] text-[13px] text-white/[0.68] transition hover:bg-white/[0.09] hover:text-white"
                    >
                      <FileText size={13} />
                      {showLyrics ? "Hide" : "Show"}
                    </button>
                  </div>

                  {showLyrics && (
                    <LyricsPanel
                      lyricsState={lyricsState}
                      currentTime={playbackPosition}
                      onSeek={requestPlaybackSeek}
                      size="sm"
                      className="h-72 rounded-md"
                    />
                  )}
                </div>

                <div className="rounded-md border border-white/[0.12] bg-white/[0.03] p-3.5">
                  <div className="font-medium text-[16px] text-white mb-3">Credits</div>
                  <div className="space-y-2.5">
                    {credits.map((credit) => (
                      <div
                        key={`${credit.name}-${credit.role}`}
                        className="flex items-start justify-between gap-2"
                      >
                        <div>
                          <div className="text-[15px] font-medium leading-5 text-white">{credit.name}</div>
                          <div className="text-[13px] leading-5 text-white/[0.58]">{credit.role}</div>
                        </div>
                        <CheckCircle2 size={15} className="text-white/[0.45] mt-1" />
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
