import { describe, expect, test } from "bun:test";
import { shouldPublishQueueMutation } from "../src/lib/queue-publish-policy";

describe("queue publish policy", () => {
  const queue = [{ id: "one" }];
  const base = { queue, queueToken: 3, queueAppendToken: 8 };

  test("ignores unrelated store updates", () => {
    expect(shouldPublishQueueMutation(base, { ...base })).toBe(false);
  });

  test("publishes a brand-new queue immediately", () => {
    expect(
      shouldPublishQueueMutation(base, {
        queue: [{ id: "two" }],
        queueToken: 4,
        queueAppendToken: 8,
      }),
    ).toBe(true);
  });

  test("publishes ordinary user queue edits immediately", () => {
    expect(
      shouldPublishQueueMutation(base, {
        queue: [...queue, { id: "two" }],
        queueToken: 3,
        queueAppendToken: 8,
      }),
    ).toBe(true);
  });

  test("defers background page appends to the loader's trailing snapshot", () => {
    expect(
      shouldPublishQueueMutation(base, {
        queue: [...queue, { id: "two" }],
        queueToken: 3,
        queueAppendToken: 9,
      }),
    ).toBe(false);
  });
});
