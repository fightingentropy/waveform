import { describe, expect, test } from "bun:test";
import {
  getApiAuthScope,
  getApiPath,
  normalizeAccountScope,
  withAccountScope,
} from "../packages/shared/src/account-scope";

describe("normalizeAccountScope", () => {
  test("treats empty and loading as anonymous", () => {
    expect(normalizeAccountScope(null)).toBe("anonymous");
    expect(normalizeAccountScope("")).toBe("anonymous");
    expect(normalizeAccountScope("loading")).toBe("anonymous");
    expect(normalizeAccountScope(" user-1 ")).toBe("user-1");
  });
});

describe("withAccountScope", () => {
  test("sets the auth query on relative API paths", () => {
    expect(withAccountScope("/api/liked", "user-1")).toBe("/api/liked?auth=user-1");
    expect(withAccountScope("/api/liked?foo=1", "user-1")).toBe("/api/liked?foo=1&auth=user-1");
  });

  test("falls back to anonymous when the scope is blank", () => {
    expect(withAccountScope("/api/home", "  ")).toBe("/api/home?auth=anonymous");
  });
});

describe("api path helpers", () => {
  test("strip query from the path and read the auth scope", () => {
    expect(getApiPath("/api/liked?auth=user-1")).toBe("/api/liked");
    expect(getApiAuthScope("/api/liked?auth=user-1")).toBe("user-1");
    expect(getApiAuthScope("/api/liked")).toBe("legacy");
  });
});
