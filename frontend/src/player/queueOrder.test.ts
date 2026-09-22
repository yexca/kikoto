import { describe, expect, it } from "vitest";

import { moveQueueItemToIndex } from "./queueOrder";

const queue = ["a", "b", "c", "d"].map((queueItemId) => ({ queueItemId }));
const ids = (items: { queueItemId?: string }[]) => items.map((item) => item.queueItemId);

describe("moveQueueItemToIndex", () => {
  it("moves an item down and up across several positions", () => {
    expect(ids(moveQueueItemToIndex(queue, "a", 2))).toEqual(["b", "c", "a", "d"]);
    expect(ids(moveQueueItemToIndex(queue, "d", 0))).toEqual(["d", "a", "b", "c"]);
  });

  it("clamps the target into the queue", () => {
    expect(ids(moveQueueItemToIndex(queue, "b", 99))).toEqual(["a", "c", "d", "b"]);
    expect(ids(moveQueueItemToIndex(queue, "c", -4))).toEqual(["c", "a", "b", "d"]);
  });

  it("keeps the original array when nothing moves", () => {
    expect(moveQueueItemToIndex(queue, "b", 1)).toBe(queue);
    expect(moveQueueItemToIndex(queue, "missing", 0)).toBe(queue);
    expect(moveQueueItemToIndex(queue, "a", Number.NaN)).toBe(queue);
  });
});
