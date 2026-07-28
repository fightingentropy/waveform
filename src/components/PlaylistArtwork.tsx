"use client";

import { ListMusic } from "lucide-react";
import { CoverImage } from "@/components/CoverImage";
import { cn } from "@/lib/utils";

type PlaylistArtworkProps = {
  coverImageUrls?: Array<string | null | undefined>;
  imageUrl?: string | null;
  className?: string;
  sizes?: string;
  loading?: "eager" | "lazy";
};

function uniqueArtworkUrls(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const value of values) {
    const url = value?.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length === 4) break;
  }
  return urls;
}

function ArtworkTile({
  src,
  sizes,
  loading,
  className,
}: {
  src: string;
  sizes: string;
  loading: "eager" | "lazy";
  className?: string;
}) {
  return (
    <span className={cn("relative min-h-0 min-w-0 overflow-hidden", className)}>
      <CoverImage
        src={src}
        alt=""
        fill
        sizes={sizes}
        loading={loading}
        className="object-cover"
      />
    </span>
  );
}

export function PlaylistArtwork({
  coverImageUrls = [],
  imageUrl,
  className,
  sizes = "180px",
  loading = "lazy",
}: PlaylistArtworkProps) {
  const covers = uniqueArtworkUrls(coverImageUrls);
  if (covers.length === 0 && imageUrl) covers.push(imageUrl);

  if (covers.length === 0) {
    return (
      <span
        aria-hidden
        className={cn(
          "grid aspect-square place-items-center overflow-hidden rounded-xl bg-white/[0.075] text-white/55",
          className,
        )}
      >
        <ListMusic size={34} strokeWidth={1.8} />
      </span>
    );
  }

  if (covers.length === 1) {
    return (
      <span
        aria-hidden
        className={cn("relative block aspect-square overflow-hidden rounded-xl bg-white/[0.045]", className)}
      >
        <CoverImage
          src={covers[0]}
          alt=""
          fill
          sizes={sizes}
          loading={loading}
          className="object-cover"
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "grid aspect-square overflow-hidden rounded-xl bg-white/[0.045]",
        covers.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2",
        className,
      )}
    >
      {covers.map((src, index) => (
        <ArtworkTile
          key={src}
          src={src}
          sizes={sizes}
          loading={index === 0 ? loading : "lazy"}
          className={covers.length === 3 && index === 0 ? "row-span-2" : undefined}
        />
      ))}
    </span>
  );
}
