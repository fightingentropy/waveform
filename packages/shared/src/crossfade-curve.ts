// Equal-power (constant-power) crossfade curve.
//
// Two different songs are uncorrelated signals, so their combined loudness during
// an overlap tracks the sum of *powers* (amplitude²), not the sum of amplitudes.
// A straight linear fade leaves each track at half amplitude at the midpoint, so
// the combined power is 0.5² + 0.5² = 0.5 (≈ -3 dB) — an audible loudness dip right
// in the middle of the transition. Fading the outgoing track along cos() and the
// incoming track along sin() keeps cos²+sin²=1 at every point, so the perceived
// volume stays flat across the whole crossfade.

/**
 * Gain multiplier (0..1) at a given progress through the fade.
 * @param progress 0 at the start of the fade, 1 at the end (clamped).
 * @param direction "out" for the outgoing track (1 → 0), "in" for the incoming (0 → 1).
 */
export function equalPowerGain(progress: number, direction: "in" | "out"): number {
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  return direction === "out"
    ? Math.cos(clamped * 0.5 * Math.PI)
    : Math.sin(clamped * 0.5 * Math.PI);
}
