import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { LibrarySourceList } from "@/features/sources/LibrarySourceList";
import type { LibraryLayout } from "@/lib/api";

function baseLayout(overrides: Partial<LibraryLayout> = {}): LibraryLayout {
  return {
    mode: "standard",
    configured: true,
    locked: true,
    onboardingCompleted: true,
    hasLegacyWorkflows: false,
    pools: [{ path: "", online: true, canReconnect: false }],
    candidates: [],
    fetchPool: "",
    localScanTriggers: { startupScan: true, watchFolders: false },
    ...overrides,
  };
}

describe("LibrarySourceList", () => {
  it("renders a single local library card in standard mode", () => {
    const rendered = renderToStaticMarkup(
      <LibrarySourceList
        localName="Main local library"
        layout={baseLayout()}
        layoutFailed={false}
        reconnectingPool={null}
        onConfigureStorage={vi.fn()}
        onReconnectPool={vi.fn(async () => undefined)}
        sources={[]}
        checkingSourceId={null}
        togglingSourceId={null}
        readOnly={false}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onCheck={vi.fn(async () => undefined)}
        onToggleEnabled={vi.fn(async () => undefined)}
      />,
    );

    expect(rendered).toContain("Main local library");
    expect(rendered).toContain("Standard · Online");
    expect(rendered.match(/aria-label="Local library settings"/g)).toHaveLength(1);
    // With no remote source, Add source appears only in the empty placeholder.
    expect(rendered.match(/Add source/g)).toHaveLength(1);
  });

  it("renders the pools as rows of one local library card in pools mode", () => {
    const rendered = renderToStaticMarkup(
      <LibrarySourceList
        localName="Main local library"
        layout={baseLayout({
          mode: "pools",
          fetchPool: "disk-a",
          pools: [
            { path: "disk-a", online: true, canReconnect: false },
            { path: "disk-b", online: false, canReconnect: true },
          ],
        })}
        layoutFailed={false}
        reconnectingPool={null}
        onConfigureStorage={vi.fn()}
        onReconnectPool={vi.fn(async () => undefined)}
        sources={[]}
        checkingSourceId={null}
        togglingSourceId={null}
        readOnly={false}
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onCheck={vi.fn(async () => undefined)}
        onToggleEnabled={vi.fn(async () => undefined)}
      />,
    );

    expect(rendered).toContain("Storage pools · 1 of 2 online");
    expect(rendered.match(/aria-label="Local library settings"/g)).toHaveLength(1);
    expect(rendered).toContain("/data/disk-a");
    expect(rendered).toContain("/data/disk-b");
    expect(rendered).toContain("Fetch pool");
    expect(rendered).toContain("Online");
    expect(rendered).toContain("Offline");
    expect(rendered).toContain("Reconnect");
  });
});
