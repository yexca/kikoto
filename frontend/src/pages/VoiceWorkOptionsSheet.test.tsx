import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { VoiceWorkOptionsSheet } from "./VoiceWorkOptionsSheet";

describe("VoiceWorkOptionsSheet", () => {
  it("keeps search and page size controls inside the mobile options surface", () => {
    const rendered = renderToStaticMarkup(
      <VoiceWorkOptionsSheet
        open
        onClose={() => undefined}
        filter="remote"
        onFilterChange={() => undefined}
        query="sample"
        onQueryChange={() => undefined}
        pageSize={48}
        pageSizeOptions={[24, 48]}
        onPageSizeChange={() => undefined}
        mobileColumns={"auto"}
        onMobileColumnsChange={() => undefined}
        selectionMode={false}
        onSelectWorks={() => undefined}
      />,
    );

    expect(rendered).toContain('aria-label="Search voice works"');
    expect(rendered).toContain('value="sample"');
    expect(rendered).toContain('aria-label="Clear voice work search"');
    expect(rendered).toContain('aria-label="Voice work page size"');
    expect(rendered).toContain("48 per page");
    expect(rendered).toContain('aria-pressed="true"');
  });
});
