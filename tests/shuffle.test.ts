import { describe, expect, test } from "bun:test";
import {
  chooseNextShuffleIndex,
  createShuffleRemaining,
  getNextShufflePool,
} from "../packages/shared/src/shuffle";

describe("createShuffleRemaining", () => {
  test("Fisher–Yates with a fixed RNG is a permutation that excludes the current index", () => {
    const remaining = createShuffleRemaining(5, 2, () => 0.999);
    expect(remaining.sort((left, right) => left - right)).toEqual([0, 1, 3, 4]);
    expect(remaining).not.toContain(2);
  });

  test("a single-track queue has no remaining pool", () => {
    expect(createShuffleRemaining(1, 0)).toEqual([]);
  });
});

describe("chooseNextShuffleIndex", () => {
  test("consumes the pool head so the warmer matches next()", () => {
    expect(chooseNextShuffleIndex(5, 0, [4, 2, 1])).toBe(4);
  });

  test("refills from a shuffled remaining set when the pool is empty", () => {
    const index = chooseNextShuffleIndex(4, 1, [], () => 0.999);
    expect([0, 2, 3]).toContain(index);
  });
});

describe("getNextShufflePool", () => {
  test("keeps a valid remaining pool in order", () => {
    expect(getNextShufflePool(4, 0, [2, 3, 1])).toEqual([2, 3, 1]);
  });
});
