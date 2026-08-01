import { describe, expect, test } from "bun:test";
import { parseByteRangeHeader } from "../src/lib/http-range";

describe("shared HTTP byte-range boundary", () => {
  test("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseByteRangeHeader("bytes=0-0", 100)).toEqual({ start: 0, end: 0 });
    expect(parseByteRangeHeader("bytes=25-", 100)).toEqual({ start: 25, end: 99 });
    expect(parseByteRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRangeHeader("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseByteRangeHeader("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  test("distinguishes unsatisfiable ranges from malformed headers", () => {
    for (const value of ["bytes=100-", "bytes=80-20", "bytes=-0"]) {
      expect(parseByteRangeHeader(value, 100)).toBe("unsatisfiable");
    }
    for (const value of [null, "items=0-1", "bytes=", "bytes=0-1,4-5", "bytes=x-1", "bytes=1-x"]) {
      expect(parseByteRangeHeader(value, 100)).toBeNull();
    }
  });

  test("rejects unsafe numeric inputs instead of rounding them", () => {
    expect(parseByteRangeHeader("bytes=0-1", 1.5)).toBeNull();
    expect(parseByteRangeHeader("bytes=9007199254740992-", 100)).toBeNull();
    expect(parseByteRangeHeader("bytes=0-9007199254740992", 100)).toBeNull();
  });
});
