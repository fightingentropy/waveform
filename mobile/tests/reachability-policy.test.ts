import { describe, expect, test } from "bun:test";
import { routeHintRestoresOnline } from "../src/lib/reachability-policy";

describe("reachability policy", () => {
  test("does not let an initial iOS connected hint overwrite a transport failure", () => {
    expect(routeHintRestoresOnline(null, true, Date.now())).toBe(false);
  });

  test("accepts a real route recovery and a clean initial route", () => {
    expect(routeHintRestoresOnline(false, true, Date.now())).toBe(true);
    expect(routeHintRestoresOnline(null, true, 0)).toBe(true);
  });

  test("never restores online from an unavailable route", () => {
    expect(routeHintRestoresOnline(true, false, 0)).toBe(false);
  });
});
