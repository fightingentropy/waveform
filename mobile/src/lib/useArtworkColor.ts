import { useMemo } from "react";
import { tintFromArtworkUri } from "@/lib/artwork-tint";

// A stable per-artwork tint gives the player a distinct backdrop without
// downloading and parsing untrusted image bytes in a second native/Node image
// stack. Cover changes still produce a new color, and the luminance cap keeps
// white controls readable.
export function useArtworkColor(uri?: string | null): string | null {
  return useMemo(() => (uri ? tintFromArtworkUri(uri) : null), [uri]);
}
