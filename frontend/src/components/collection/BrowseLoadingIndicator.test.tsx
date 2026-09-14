import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowseLoadingIndicator } from "./BrowseLoadingIndicator";

describe("BrowseLoadingIndicator", () => {
  it("announces a pending browse request", () => {
    const rendered = renderToStaticMarkup(<BrowseLoadingIndicator refreshing label="Refreshing library works" />);

    expect(rendered).toContain('role="status"');
    expect(rendered).toContain('aria-label="Refreshing library works"');
  });

  it("does not render while idle", () => {
    expect(renderToStaticMarkup(<BrowseLoadingIndicator refreshing={false} label="Refreshing library works" />)).toBe(
      "",
    );
  });
});
