import { BarChart3, Clock3, Play } from "lucide-react";
import {
  type ListeningStatsPayload,
  type ListeningWeek,
  useApiData,
  withAccountScope,
} from "@/client/api";
import { useAuth } from "@/client/auth";
import { CoverImage } from "@/components/CoverImage";
import { requestImmediatePlayback } from "@/lib/playback-gesture";
import { usePlayerStore } from "@/store/player";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function mondayUtc(date: Date): string {
  const dayOffset = (date.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() - dayOffset,
  ));
  return monday.toISOString().slice(0, 10);
}

function weekHeading(weekStart: string): string | null {
  const thisMonday = mondayUtc(new Date());
  if (weekStart === thisMonday) return "This week";
  const lastMonday = new Date(`${thisMonday}T00:00:00Z`);
  lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
  return weekStart === lastMonday.toISOString().slice(0, 10) ? "Last week" : null;
}

function weekRange(week: ListeningWeek): string {
  return `${DATE_FORMAT.format(new Date(`${week.weekStart}T00:00:00Z`))} – ${DATE_FORMAT.format(
    new Date(`${week.weekEnd}T00:00:00Z`),
  )}`;
}

function WeekCard({ week }: { week: ListeningWeek }) {
  const setQueue = usePlayerStore((state) => state.setQueue);
  const heading = weekHeading(week.weekStart);
  const playTopSong = () => {
    if (!week.topSong) return;
    requestImmediatePlayback(week.topSong);
    setQueue([week.topSong], 0);
  };

  return (
    <section className="rounded-2xl border border-white/[0.1] bg-white/[0.035] p-4 sm:p-5">
      <div>
        <h2 className="text-xl font-bold text-white">{heading ?? weekRange(week)}</h2>
        {heading ? <p className="mt-0.5 text-sm text-white/50">{weekRange(week)}</p> : null}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-white/[0.055] p-4">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-white/50">
            <Clock3 size={15} /> Minutes listened
          </div>
          <p className="mt-2 text-4xl font-extrabold tabular-nums text-white">{week.minutesListened}</p>
        </div>

        <div className="rounded-xl bg-white/[0.055] p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-white/50">Top artist</p>
          {week.topArtist ? (
            <div className="mt-3 flex items-center gap-3">
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-white/[0.06]">
                <CoverImage src={week.topArtist.image ?? undefined} alt={week.topArtist.name} fill sizes="56px" />
              </div>
              <p className="min-w-0 truncate font-semibold text-white">{week.topArtist.name}</p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-white/45">No artist yet</p>
          )}
        </div>

        <button
          type="button"
          disabled={!week.topSong}
          onClick={playTopSong}
          className="group rounded-xl bg-white/[0.055] p-4 text-left transition hover:bg-white/[0.09] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default disabled:hover:bg-white/[0.055]"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-white/50">Top song</p>
          {week.topSong ? (
            <div className="mt-3 flex items-center gap-3">
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-white/[0.06]">
                <CoverImage
                  src={week.topSong.imageUrl}
                  networkSrc={week.topSong.networkImageUrl}
                  alt={week.topSong.title}
                  fill
                  sizes="56px"
                />
                <span className="absolute inset-0 grid place-items-center bg-black/35 opacity-0 transition group-hover:opacity-100">
                  <Play size={20} fill="currentColor" />
                </span>
              </div>
              <div className="min-w-0">
                <p className="truncate font-semibold text-white">{week.topSong.title}</p>
                <p className="truncate text-sm text-white/50">{week.topSong.artist}</p>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-sm text-white/45">No song yet</p>
          )}
        </button>
      </div>
    </section>
  );
}

export default function ListeningStatsPage() {
  const { user, status } = useAuth();
  const { data, loading, error, retry } = useApiData<ListeningStatsPayload>(
    withAccountScope("/api/stats/listening", user?.id ?? status),
    { weeks: [] },
    { enabled: status === "authenticated", keepPreviousData: true },
  );

  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-background px-4 py-8 text-white sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <div className="mb-7 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-emerald-500 text-black">
            <BarChart3 size={22} />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Listening stats</h1>
            <p className="mt-0.5 text-sm text-white/55">Your last six weeks of listening.</p>
          </div>
        </div>

        {loading && data.weeks.length === 0 ? <p className="text-white/55">Loading listening stats…</p> : null}
        {error ? (
          <div role="alert" className="rounded-xl border border-red-300/20 bg-red-400/[0.06] p-5">
            <p className="text-sm text-red-100">{error}</p>
            <button type="button" onClick={retry} className="mt-3 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">
              Retry
            </button>
          </div>
        ) : null}
        {!loading && !error && data.weeks.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.1] bg-white/[0.035] p-8 text-center">
            <h2 className="text-lg font-semibold">No listening yet</h2>
            <p className="mt-1 text-sm text-white/55">Play some music and your weekly stats will show up here.</p>
          </div>
        ) : null}
        <div className="grid gap-4">{data.weeks.map((week) => <WeekCard key={week.weekStart} week={week} />)}</div>
      </div>
    </div>
  );
}
