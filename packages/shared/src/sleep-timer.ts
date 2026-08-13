export const SLEEP_TIMER_MINUTE_OPTIONS = [5, 15, 30, 45, 60] as const;

export function sleepTimerRemainingMinutes(endsAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((endsAt - now) / 60_000));
}
