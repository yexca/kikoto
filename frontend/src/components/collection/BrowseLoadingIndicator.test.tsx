import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrowseLoadingIndicator } from "./BrowseLoadingIndicator";

describe("BrowseLoadingIndicator", () => {
  it("renders a fixed, accessible spinner while a browse request is pending", () => {
    const rendered = renderToStaticMarkup(<BrowseLoadingIndicator refreshing label="Refreshing library works" />);

    expect(rendered).toContain('role="status"');
    expect(rendered).toContain('aria-label="Refreshing library works"');
    expect(rendered).toContain("fixed");
    expect(rendered).toContain("animate-spin");
  });

  it("does not render while idle", () => {
    expect(renderToStaticMarkup(<BrowseLoadingIndicator refreshing={false} label="Refreshing library works" />)).toBe(
      "",
    );
  });
});
