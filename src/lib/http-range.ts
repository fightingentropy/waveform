export type ParsedByteRange = { start: number; end: number } | "unsatisfiable" | null;

/**
 * Parse one RFC-style bytes range. Malformed/unsupported syntax is ignored
 * (null); syntactically valid but impossible ranges are explicitly marked so
 * callers can return 416 with the unsatisfied `Content-Range` form.
 */
export function parseByteRangeHeader(rangeHeader: string | null, size: number): ParsedByteRange {
  if (!rangeHeader || !rangeHeader.startsWith("bytes=") || !Number.isSafeInteger(size) || size <= 0) {
    return null;
  }
  const value = rangeHeader.slice("bytes=".length).trim();
  if (!value || value.includes(",")) return null;
  const dash = value.indexOf("-");
  if (dash < 0) return null;

  const startRaw = value.slice(0, dash);
  const endRaw = value.slice(dash + 1);
  if (!startRaw) {
    if (!/^\d+$/.test(endRaw)) return null;
    const suffixLength = Number(endRaw);
    if (!Number.isSafeInteger(suffixLength)) return null;
    if (suffixLength <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  if (!/^\d+$/.test(startRaw)) return null;
  const start = Number(startRaw);
  if (!Number.isSafeInteger(start)) return null;
  if (start >= size) return "unsatisfiable";
  if (endRaw && !/^\d+$/.test(endRaw)) return null;
  let end = endRaw ? Number(endRaw) : size - 1;
  if (!Number.isSafeInteger(end)) return null;
  if (end < start) return "unsatisfiable";
  if (end >= size) end = size - 1;
  return { start, end };
}
