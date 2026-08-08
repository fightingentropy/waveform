import { Image, type ImageContentFit, type ImageStyle } from "expo-image";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type StyleProp } from "react-native";
import { API_ORIGIN, toAbsoluteApiUrl } from "@/lib/config";
import { stableArtworkCacheKey } from "@/lib/artwork-cache";
import { resolveMediaPath } from "@/lib/offline-db";
import { getOfflineAccountScope, keyFor, useOfflineStore } from "@/store/offline";

const FALLBACK_COVER = `${API_ORIGIN}/apple-icon.png`;

type CoverImageProps = {
  src?: string | null;
  // Remote cover to retry with when `src` (a device-local offline file) fails.
  networkSrc?: string | null;
  contentFit?: ImageContentFit;
  style?: StyleProp<ImageStyle>;
  // expo-image transition (ms) — mirrors the web cover-settle fade.
  transition?: number;
  recyclingKey?: string;
  // Song identity lets downloaded/playback-cached artwork win over the network.
  offlineSongId?: string;
};

// RN replacement for src/components/CoverImage.tsx. expo-image caches covers and
// decodes off-thread; we keep the candidate fallback chain (src → networkSrc →
// bundled fallback) advancing on load error. The web r2 ?w= srcSet is dropped —
// /api/artwork/local serves the cover as-is (§6).
export function CoverImage({
  src,
  networkSrc,
  contentFit = "cover",
  style,
  transition = 220,
  recyclingKey,
  offlineSongId,
}: CoverImageProps) {
  const offlineKey = offlineSongId
    ? keyFor(getOfflineAccountScope(), offlineSongId)
    : null;
  const storedCoverPath = useOfflineStore(
    useCallback(
      (state) => {
        if (!offlineKey) return null;
        const record = state.records[offlineKey];
        return record?.status === "ready" ? (record.coverPath ?? null) : null;
      },
      [offlineKey],
    ),
  );
  const localCover = resolveMediaPath(storedCoverPath);

  const candidates = useMemo(() => {
    const list: Array<{ uri: string; cacheKey: string }> = [];
    const push = (value?: string | null) => {
      if (!value?.trim()) return;
      const uri = toAbsoluteApiUrl(value);
      if (list.some((candidate) => candidate.uri === uri)) return;
      list.push({ uri, cacheKey: stableArtworkCacheKey(value) });
    };
    push(localCover);
    push(src);
    push(networkSrc);
    push(FALLBACK_COVER);
    return list;
  }, [localCover, src, networkSrc]);

  const [stage, setStage] = useState(0);
  useEffect(() => setStage(0), [candidates]);

  const source = candidates[Math.min(stage, candidates.length - 1)];

  return (
    <Image
      style={style}
      source={source}
      contentFit={contentFit}
      transition={transition}
      recyclingKey={recyclingKey ?? offlineSongId ?? src ?? undefined}
      cachePolicy="memory-disk"
      onError={() => setStage((s) => Math.min(s + 1, candidates.length - 1))}
    />
  );
}
