import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import "@/i18n";
import { WorkSelectionAction, WorkSelectionBar, workSelectionState } from "./WorkSelectionBar";

describe("workSelectionState", () => {
  it("reports none, some, and all against the visible scope", () => {
    expect(workSelectionState({ selectedCount: 0, scopeSelectableCount: 3, scopeSelectedCount: 0 })).toBe("none");
    expect(workSelectionState({ selectedCount: 1, scopeSelectableCount: 3, scopeSelectedCount: 1 })).toBe("some");
    expect(workSelectionState({ selectedCount: 3, scopeSelectableCount: 3, scopeSelectedCount: 3 })).toBe("all");
  });

  it("keeps selections from another page partial rather than empty", () => {
    expect(workSelectionState({ selectedCount: 2, scopeSelectableCount: 3, scopeSelectedCount: 0 })).toBe("some");
    expect(workSelectionState({ selectedCount: 2, scopeSelectableCount: 0, scopeSelectedCount: 0 })).toBe("some");
  });
});

describe("WorkSelectionBar", () => {
  const render = (selectedCount: number, scopeSelectedCount: number) =>
    renderToStaticMarkup(
      <WorkSelectionBar
        selectedCount={selectedCount}
        scopeSelectableCount={3}
        scopeSelectedCount={scopeSelectedCount}
        onSelectScope={() => undefined}
        onClear={() => undefined}
        onExit={() => undefined}
      >
        <WorkSelectionAction icon={null} label="Fetch" count={selectedCount} onClick={() => undefined} />
      </WorkSelectionBar>,
    );

  it("replaces separate select-all and cancel commands with one tri-state checkbox", () => {
    const partial = render(1, 1);
    expect(partial).toContain('aria-checked="mixed"');
    expect(partial).toContain('aria-label="Select all on this page"');
    expect(partial).toContain('aria-label="Exit selection mode"');
    expect(partial).toContain('aria-label="Fetch (1)"');

    const full = render(3, 3);
    expect(full).toContain('aria-checked="true"');
    expect(full).toContain('aria-label="Clear selection"');
  });

  it("disables a bulk action when none of the selection applies to it", () => {
    expect(render(0, 0)).toMatch(/<button(?=[^>]*aria-label="Fetch \(0\)")(?=[^>]*disabled="")[^>]*>/);
  });
});
