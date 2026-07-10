export function routeHintRestoresOnline(
  previousRouteAvailable: boolean | null,
  nextRouteAvailable: boolean,
  lastTransportFailureAt: number,
): boolean {
  if (!nextRouteAvailable) return false;
  // A genuine interface recovery is meaningful. The initial iOS "connected"
  // snapshot is only accepted when no end-to-end request has already failed.
  return previousRouteAvailable === false || lastTransportFailureAt === 0;
}
