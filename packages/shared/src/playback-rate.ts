export const PLAYBACK_RATE_CYCLE = [1, 1.25, 1.5, 1.75, 2, 0.75];

export function nextPlaybackRate(rate: number): number {
  const index = PLAYBACK_RATE_CYCLE.indexOf(rate);
  return PLAYBACK_RATE_CYCLE[(index + 1) % PLAYBACK_RATE_CYCLE.length] ?? 1;
}

export function formatPlaybackRate(rate: number): string {
  return `${rate}×`;
}
