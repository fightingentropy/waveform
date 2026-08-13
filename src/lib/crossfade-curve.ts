import { equalPowerGain } from "@spotify/shared/crossfade-curve";

export { equalPowerGain };

// Number of linear segments used to trace the curve on a Web Audio AudioParam.
// 24 steps over a multi-second fade is aurally indistinguishable from a true cosine.
export const EQUAL_POWER_RAMP_STEPS = 24;

/**
 * Schedule an equal-power ramp on a GainNode's AudioParam as a chain of short
 * linear segments (one `setValueAtTime` anchor + N `linearRampToValueAtTime`).
 *
 * Piecewise-linear is deliberate rather than `setValueCurveAtTime`: the crossfade's
 * cancel/commit path interrupts a running ramp with `cancelScheduledValues` +
 * `setValueAtTime`, and several browsers throw if that lands inside an active value
 * curve — but it overrides linear ramps cleanly.
 */
export function scheduleEqualPowerRamp(
  param: AudioParam,
  startTime: number,
  duration: number,
  peak: number,
  direction: "in" | "out",
): void {
  param.cancelScheduledValues(startTime);
  param.setValueAtTime(peak * equalPowerGain(0, direction), startTime);
  for (let i = 1; i <= EQUAL_POWER_RAMP_STEPS; i += 1) {
    const progress = i / EQUAL_POWER_RAMP_STEPS;
    param.linearRampToValueAtTime(
      peak * equalPowerGain(progress, direction),
      startTime + duration * progress,
    );
  }
}
