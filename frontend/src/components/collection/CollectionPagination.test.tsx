import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CollectionPagination } from "./CollectionPagination";

describe("CollectionPagination", () => {
  it("exposes complete page context in the compact mobile summary", () => {
    const rendered = renderToStaticMarkup(
      <CollectionPagination
        placement="top"
        page={2}
        pageSize={24}
        totalItems={48}
        totalPages={2}
        itemLabel="voice actors"
        ariaLabel="Voice actor pages"
        compactMobile
        refreshing
        refreshingLabel="Refreshing voice actors"
        onPageChange={() => undefined}
      />,
    );

    expect(rendered).toContain("Page 2 of 2, 48 voice actors");
    expect(rendered).toContain('aria-label="Voice actor pages controls"');
    expect(rendered).toContain('aria-label="Refreshing voice actors"');
    expect(rendered).toContain('aria-label="Previous page"');
    expect(rendered).toContain('aria-label="Next page"');
  });

  it("keeps an authored desktop summary in compact mode", () => {
    const rendered = renderToStaticMarkup(
      <CollectionPagination
        placement="top"
        page={1}
        pageSize={24}
        totalItems={30}
        totalPages={2}
        itemLabel="circles"
        summary="1-24 of 30 circles"
        compactMobile
        onPageChange={() => undefined}
      />,
    );

    expect(rendered).toContain("1-24 of 30 circles");
    expect(rendered).toContain("Page 1 of 2, 30 circles");
  });
});
