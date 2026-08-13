"use client";

import { Ticket } from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import { PageError } from "@/components/PageError";
import { useApiData } from "@/client/api";
import { formatEventDate, type LiveEvent, type LiveEventSection } from "@/lib/live-events";

function EventCard({ event, eager }: { event: LiveEvent; eager: boolean }) {
  const { month, day } = formatEventDate(event.date);
  const content = (
    <>
      <div className="relative aspect-square overflow-hidden rounded-lg bg-white/[0.05]">
        <CoverImage
          src={event.imageUrl}
          alt={event.artists}
          fill
          className="object-cover transition duration-300 group-hover:scale-[1.03]"
          loading={eager ? "eager" : "lazy"}
          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 200px"
        />
        <div className="absolute left-2 top-2 flex flex-col items-center rounded-lg bg-black/60 px-2.5 py-1 text-center backdrop-blur">
          <span className="text-[11px] uppercase leading-3 tracking-wide text-white/85">{month}</span>
          <span className="text-lg font-extrabold leading-6 text-white">{day}</span>
        </div>
      </div>
      <div className="mt-2 line-clamp-2 text-[15px] font-bold leading-5 text-white" title={event.artists}>
        {event.artists}
      </div>
      <div className="mt-1 line-clamp-1 text-[13px] leading-4 text-[#b3b3b3]" title={event.venue}>
        {event.venue}
      </div>
    </>
  );
  return event.url ? (
    <a
      className="group rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
      href={event.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View tickets for ${event.artists}`}
    >
      {content}
    </a>
  ) : (
    <div className="group">{content}</div>
  );
}

function EventsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5" aria-hidden>
      {Array.from({ length: 10 }).map((_, item) => (
        <div key={item} className="space-y-3">
          <div className="wf-skeleton aspect-square rounded-lg" />
          <div className="wf-skeleton h-4 rounded-full" />
          <div className="wf-skeleton h-3 w-2/3 rounded-full" />
        </div>
      ))}
    </div>
  );
}

export default function EventsPage() {
  // Public feed (same for everyone) — fetched plain, no account scope. Do not
  // silently substitute old sample dates when the live provider is unavailable.
  const { data, loading, error, retry } = useApiData<{ sections: LiveEventSection[] }>("/api/events", { sections: [] });
  const today = new Date().toISOString().slice(0, 10);
  const sections = data.sections
    .map((section) => ({ ...section, events: section.events.filter((event) => event.date >= today) }))
    .filter((section) => section.events.length > 0);
  const showSkeleton = loading && data.sections.length === 0;

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background px-4 py-6 text-white sm:px-6">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-white/[0.075] text-white/60">
            <Ticket size={23} />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Live Events</h1>
            <div className="mt-1 text-sm text-white/[0.62]">Concerts &amp; venues in London</div>
          </div>
        </div>

        {showSkeleton ? (
          <EventsSkeleton />
        ) : error ? (
          <PageError compact message={error} onRetry={retry} retryLabel="Retry" />
        ) : sections.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/[0.04] p-5 text-white/[0.68]">
            No upcoming London events are available right now.
          </div>
        ) : (
          sections.map((section) => (
            <section key={section.key} aria-label={section.title} className="mb-9 md:mb-10">
              <div className="mb-4">
                <div className="text-sm text-white/[0.62]">{section.eyebrow}</div>
                <h2 className="mt-0.5 text-2xl font-bold">{section.title}</h2>
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {section.events.map((event, index) => (
                  <EventCard key={event.id} event={event} eager={index < 5} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
