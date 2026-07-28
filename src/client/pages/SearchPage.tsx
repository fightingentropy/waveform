import MobileSearch from "@/components/MobileSearch";
import { useApiData, withAccountScope, type SearchIndexPayload } from "@/client/api";
import { useAuth } from "@/client/auth";

export default function SearchPage() {
  const { user, status } = useAuth();
  const { data, loading, error, retry } = useApiData<SearchIndexPayload>(
    withAccountScope("/api/search-index", user?.id ?? status),
    {
      songs: [],
    },
    {
      enabled: status !== "loading",
      keepPreviousData: true,
    },
  );
  const songs = data.songs;

  if (loading || status === "loading") {
    return (
      <div className="mx-auto max-w-7xl px-5 pb-8 pt-[18px] sm:px-6">
        <div className="mb-4 text-[34px] font-bold leading-10 tracking-[-0.9px]">Search</div>
        <div className="space-y-3" aria-hidden>
          <div className="wf-skeleton h-[50px] rounded-xl" />
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="flex min-h-[64px] items-center gap-4 rounded-xl">
              <div className="wf-skeleton h-14 w-14 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="wf-skeleton h-4 w-48 max-w-full rounded-full" />
                <div className="wf-skeleton h-3 w-28 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="mx-auto max-w-7xl px-5 pb-8 pt-[18px] sm:px-6">
        <p className="text-red-300">{error}</p>
        <button type="button" onClick={retry} className="mt-4 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">Try again</button>
      </div>
    );
  }

  return (
    <>
      <MobileSearch songs={songs} />
    </>
  );
}
