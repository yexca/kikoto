import { describe, expect, it } from "vitest";

import { loadAllPages } from "./pagedList";

function pagedSource(total: number, pageSize: number) {
  const requested: number[] = [];
  const loadPage = async (page: number) => {
    requested.push(page);
    const start = (page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - start));
    return { items: Array.from({ length: count }, (_, index) => start + index), total };
  };
  return { requested, loadPage };
}

describe("loadAllPages", () => {
  it("reads past the first page until the reported total is loaded", async () => {
    const source = pagedSource(250, 100);

    const items = await loadAllPages(source.loadPage, 100);

    expect(items).toHaveLength(250);
    expect(items[249]).toBe(249);
    expect(source.requested).toEqual([1, 2, 3]);
  });

  it("asks once when everything fits on one page", async () => {
    const exact = pagedSource(100, 100);
    const short = pagedSource(7, 100);
    const empty = pagedSource(0, 100);

    expect(await loadAllPages(exact.loadPage, 100)).toHaveLength(100);
    expect(await loadAllPages(short.loadPage, 100)).toHaveLength(7);
    expect(await loadAllPages(empty.loadPage, 100)).toEqual([]);
    expect([exact.requested, short.requested, empty.requested]).toEqual([[1], [1], [1]]);
  });

  it("never requests more than the page bound", async () => {
    const source = pagedSource(1000, 10);

    expect(await loadAllPages(source.loadPage, 10, 3)).toHaveLength(30);
    expect(source.requested).toEqual([1, 2, 3]);
  });
});
