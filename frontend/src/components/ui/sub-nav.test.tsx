import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubNavTabs, type SubNavItem } from "./sub-nav";

const items: SubNavItem<"works" | "tags" | "circles">[] = [
  { value: "works", label: "Works", id: "tab-works", controls: "panel", description: "Works group, 3 works" },
  { value: "tags", label: "Tags", id: "tab-tags", controls: "panel", separated: true },
  { value: "circles", label: "Circles", id: "tab-circles", controls: "panel", suffix: <span>4</span> },
];

describe("SubNavTabs", () => {
  const markup = renderToStaticMarkup(
    <SubNavTabs label="Views" items={items} selected="tags" onSelect={() => undefined} trailing={<b>Actions</b>} />,
  );

  it("names the tab list and every tab, and marks only the open tab selectable by Tab", () => {
    expect(markup).toContain('role="tablist" aria-label="Views" aria-orientation="horizontal"');
    expect(markup).toMatch(/id="tab-tags"[^>]*aria-selected="true"[^>]*tabindex="0"/);
    expect(markup).toMatch(/id="tab-works"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    expect(markup).toContain("Circles");
  });

  it("reads a description after the name, and keeps trailing page controls in the same row", () => {
    expect(markup).toMatch(/id="tab-works"[^>]*aria-describedby="[^"]+"/);
    expect(markup).toContain("Works group, 3 works");
    expect(markup).toContain("<b>Actions</b>");
  });
});
