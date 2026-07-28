export type AuthSessionStatus = "loading" | "authenticated" | "unauthenticated";

export type AuthBootstrap<T> = {
  user: T | null;
  status: AuthSessionStatus;
  shouldRefreshSession: boolean;
  shouldRetryServerSignOut: boolean;
};

// Async auth mutations may finish after sign-out, forced logout, or a different
// sign-in. Only the generation that started the request may commit its result.
export function isCurrentAuthMutation(startGeneration: number, currentGeneration: number): boolean {
  return startGeneration === currentGeneration;
}

// A local sign-out is an explicit user decision, so it outranks both a stale
// cached user and a surviving native session cookie. Only a later explicit
// sign-in is allowed to clear that decision.
export function resolveAuthBootstrap<T>(
  cachedUser: T | null,
  locallySignedOut: boolean,
): AuthBootstrap<T> {
  if (locallySignedOut) {
    return {
      user: null,
      status: "unauthenticated",
      shouldRefreshSession: false,
      shouldRetryServerSignOut: true,
    };
  }

  return {
    user: cachedUser,
    status: cachedUser ? "authenticated" : "loading",
    shouldRefreshSession: true,
    shouldRetryServerSignOut: false,
  };
}
