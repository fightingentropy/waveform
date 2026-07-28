// Design-system tokens for non-className contexts (icon colors, surfaces, RNTP,
// reanimated). Mirror of tailwind.config.js + styles.css. See §4 of the port brief
// and docs/port-notes/styles-design.md for provenance.

export const colors = {
  background: "#000000",
  surface: "#0c0c0d",
  foreground: "#f2f2f2",
  muted: "rgba(255,255,255,0.60)",
  dim: "rgba(255,255,255,0.40)",
  // Legacy aliases stay for behavior compatibility, but selection is now
  // monochrome. Artwork is the only non-semantic source of colour.
  green: "#f2f2f2",
  emerald: "#f2f2f2",
  emeraldDarkCheck: "#050505",
  card: "rgba(255,255,255,0.045)",
  cardHover: "rgba(255,255,255,0.065)",
  cardActive: "rgba(255,255,255,0.09)",
  glass: "rgba(14,14,15,0.70)",
  glassStrong: "rgba(10,10,11,0.92)",
  line: "rgba(255,255,255,0.08)",
  hairline: "rgba(255,255,255,0.12)",
  iconIdle: "rgba(255,255,255,0.52)",
  backdrop: "rgba(0,0,0,0.76)",
  skeletonBase: "rgba(255,255,255,0.055)",
  skeletonShimmer: "rgba(255,255,255,0.09)",
  white: "#ffffff",
} as const;

export const layout = {
  mobileNavHeight: 58,
  mobilePlayerHeight: 66,
  floatingInset: 10,
  floatingGap: 8,
  cardWidthSm: 144, // w-36
  cardWidthMd: 160, // w-40 (>=sm)
  listRowMinHeight: 64,
} as const;

// Easing curves (cubic-bezier control points) for Reanimated `Easing.bezier(...)`.
export const motion = {
  routeEnter: { ms: 220, bezier: [0.16, 1, 0.3, 1] as const },
  coverSettle: { ms: 520, bezier: [0.16, 1, 0.3, 1] as const },
  skeleton: { ms: 1250 },
  pressScale: { ms: 160, scale: 0.985 },
  cardPress: { ms: 220, scale: 0.985, bezier: [0.2, 0.8, 0.2, 1] as const },
  listRow: { ms: 170 },
  sheetBackdrop: { ms: 280 },
  npOpen: { ms: 360, bezier: [0.16, 1, 0.3, 1] as const, opacityMs: 260 },
  npClose: { ms: 360, bezier: [0.4, 0, 1, 1] as const, opacityMs: 260, opacityDelayMs: 120 },
  marquee: { ms: 9000, startDelayMs: 1500, edgeFadePx: 14 },
} as const;
