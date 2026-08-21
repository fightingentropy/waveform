import { describe, expect, test } from "bun:test";
import { shouldNavigateToTabRoot } from "../src/lib/tab-navigation-policy";

describe("root tab navigation policy", () => {
  test("does not navigate again when the requested tab root is already focused", () => {
    expect(shouldNavigateToTabRoot("/", "/", false)).toBe(false);
    expect(shouldNavigateToTabRoot("/search", "/search", false)).toBe(false);
    expect(shouldNavigateToTabRoot("/library", "/library", false)).toBe(false);
  });

  test("switches to a different tab root", () => {
    expect(shouldNavigateToTabRoot("/library", "/", false)).toBe(true);
    expect(shouldNavigateToTabRoot("/", "/search", false)).toBe(true);
  });

  test("reselects the requested tab after unwinding a pushed screen", () => {
    expect(shouldNavigateToTabRoot("/settings", "/", true)).toBe(true);
    expect(shouldNavigateToTabRoot("/liked", "/library", true)).toBe(true);
  });
});
