import { describe, expect, it } from "vitest";

import { queueDragShift, resolveQueueDrag } from "./queueDrag";

const layout = [0, 56, 112, 168].map((top) => ({ top, height: 56 }));

describe("resolveQueueDrag", () => {
  it("changes the drop index after the leading edge passes a neighbor's center", () => {
    expect(resolveQueueDrag(layout, 0, 27).target).toBe(0);
    expect(resolveQueueDrag(layout, 0, 29).target).toBe(1);
    expect(resolveQueueDrag(layout, 0, 120).target).toBe(2);
    expect(resolveQueueDrag(layout, 3, -120).target).toBe(1);
  });

  it("keeps the dragged row inside the list", () => {
    expect(resolveQueueDrag(layout, 1, -500)).toEqual({ offset: -56, target: 0 });
    expect(resolveQueueDrag(layout, 1, 500)).toEqual({ offset: 112, target: 3 });
  });
});

describe("queueDragShift", () => {
  it("moves only the rows between the source and drop index", () => {
    expect([0, 1, 2, 3].map((index) => queueDragShift(index, 0, 2, 56))).toEqual([0, -56, -56, 0]);
    expect([0, 1, 2, 3].map((index) => queueDragShift(index, 3, 1, 56))).toEqual([0, 56, 56, 0]);
  });
});
