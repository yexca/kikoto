import { describe, expect, it } from "vitest";

import { moveQueueItemToIndex, removeQueueItemById, removeQueueItemsById, stepQueueIndex } from "./queueOrder";

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

describe("stepQueueIndex", () => {
  it("wraps at either end of the queue only in loop mode", () => {
    expect(stepQueueIndex(3, 4, "loop", 1)).toBe(0);
    expect(stepQueueIndex(0, 4, "loop", -1)).toBe(3);
    expect(stepQueueIndex(3, 4, "order", 1)).toBe(3);
    expect(stepQueueIndex(0, 4, "single", -1)).toBe(0);
  });

  it("steps within the queue in every mode", () => {
    expect(stepQueueIndex(1, 4, "order", 1)).toBe(2);
    expect(stepQueueIndex(1, 4, "single", -1)).toBe(0);
  });
});

describe("removeQueueItemById", () => {
  it("keeps the current item selected when an earlier item is removed", () => {
    const result = removeQueueItemById(queue, 2, "a");
    expect(ids(result!.items)).toEqual(["b", "c", "d"]);
    expect(result!.currentIndex).toBe(1);
  });

  it("returns the same result when React runs the update twice", () => {
    const first = removeQueueItemById(queue, 2, "a");
    const second = removeQueueItemById(queue, 2, "a");
    expect(second).toEqual(first);
    expect(ids(queue)).toEqual(["a", "b", "c", "d"]);
  });

  it("selects the next item when the current one is removed", () => {
    expect(removeQueueItemById(queue, 1, "b")!.currentIndex).toBe(1);
    expect(removeQueueItemById(queue, 1, "c")!.currentIndex).toBe(1);
  });

  it("stops on the new last item when the current one was last", () => {
    const result = removeQueueItemById(queue, 3, "d")!;
    expect(ids(result.items)).toEqual(["a", "b", "c"]);
    expect(result.currentIndex).toBe(2);
    expect(result.stop).toBe(true);
    expect(removeQueueItemById(queue, 1, "b")!.stop).toBe(false);
  });

  it("empties the queue or leaves it alone when the item is missing", () => {
    expect(removeQueueItemById([{ queueItemId: "a" }], 0, "a")).toEqual({ items: [], currentIndex: 0, stop: true });
    expect(removeQueueItemById(queue, 1, "missing")).toBeNull();
  });
});

describe("removeQueueItemsById", () => {
  it("removes every item, each removal building on the one before", () => {
    const result = removeQueueItemsById(queue, 3, ["a", "c"]);
    expect(ids(result!.items)).toEqual(["b", "d"]);
    expect(result!.currentIndex).toBe(1);
    expect(result!.removedCurrent).toBe(false);
  });

  it("reports removing the current item and ignores missing ones", () => {
    const result = removeQueueItemsById(queue, 1, ["missing", "b", "d"]);
    expect(ids(result!.items)).toEqual(["a", "c"]);
    expect(result!.currentIndex).toBe(1);
    expect(result!.removedCurrent).toBe(true);
    expect(removeQueueItemsById(queue, 1, ["missing"])).toBeNull();
  });
});
