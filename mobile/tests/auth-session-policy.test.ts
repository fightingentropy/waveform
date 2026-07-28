import { describe, expect, test } from "bun:test";
import { isCurrentAuthMutation, resolveAuthBootstrap } from "../src/lib/auth-session-policy";

describe("auth session policy", () => {
  test("an explicit local sign-out wins over a stale cached user and cookie refresh", () => {
    const cachedUser = { id: "cached-user" };
    expect(resolveAuthBootstrap(cachedUser, true)).toEqual({
      user: null,
      status: "unauthenticated",
      shouldRefreshSession: false,
      shouldRetryServerSignOut: true,
    });
  });

  test("a cached user paints immediately when there is no sign-out sentinel", () => {
    const cachedUser = { id: "cached-user" };
    expect(resolveAuthBootstrap(cachedUser, false)).toEqual({
      user: cachedUser,
      status: "authenticated",
      shouldRefreshSession: true,
      shouldRetryServerSignOut: false,
    });
  });

  test("a clean first launch checks the server session", () => {
    expect(resolveAuthBootstrap(null, false)).toEqual({
      user: null,
      status: "loading",
      shouldRefreshSession: true,
      shouldRetryServerSignOut: false,
    });
  });

  test("an auth mutation cannot commit after an authoritative auth change", () => {
    expect(isCurrentAuthMutation(4, 4)).toBe(true);
    expect(isCurrentAuthMutation(4, 5)).toBe(false);
  });
});
