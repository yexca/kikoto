import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import "@/i18n";
import { ToastProvider } from "@/components/ui/toast";
import type { CacheOverview } from "@/lib/api";

import { TranscodeCacheSection } from "./StorageCachePanels";

describe("TranscodeCacheSection", () => {
  it("describes transcode cache usage as used of limit on the meter", () => {
    const rendered = renderToStaticMarkup(
      <ToastProvider>
        <TranscodeCacheSection
          overview={
            {
              transcode: { files: 12, bytes: 1024 ** 3, limitBytes: 4 * 1024 ** 3, scannedAt: "2026-01-01T00:00:00Z" },
            } as CacheOverview
          }
          scanning={false}
          readOnly
          onChanged={async () => undefined}
        />
      </ToastProvider>,
    );

    expect(rendered).toContain('role="meter"');
    expect(rendered).toContain('aria-valuenow="25"');
    expect(rendered).toContain('aria-valuetext="1.0 GB of 4.0 GB (25%)"');
  });
});
