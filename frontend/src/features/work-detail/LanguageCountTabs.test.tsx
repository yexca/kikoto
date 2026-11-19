import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import "@/i18n";

import { LanguageCountTabs } from "./LanguageCountTabs";

describe("LanguageCountTabs", () => {
  const markup = renderToStaticMarkup(
    <LanguageCountTabs
      label="Language"
      languages={[
        ["ja-jp", "metadata.japanese"],
        ["en-us", "metadata.english"],
      ]}
      selected="en-us"
      counts={new Map([["ja-jp", 3]])}
      pending={new Set(["en-us"])}
      changedLabel="Unsaved changes"
      countTitle={(count) => `${count} of 4`}
      onSelect={() => undefined}
    />,
  );
  const tabs = markup.match(/<button[^>]*>.*?<\/button>/g) ?? [];

  it("names the strip and selects one language", () => {
    expect(markup).toContain('role="tablist" aria-label="Language"');
    expect(tabs.map((tab) => /aria-selected="true"/.test(tab))).toEqual([false, true]);
  });

  it("counts a covered language and reads out a language with unsaved changes", () => {
    expect(tabs[0]).toContain("Japanese");
    expect(tabs[0]).toContain('title="3 of 4"');
    expect(tabs[0]).toMatch(/>3<\/span>/);
    expect(tabs[0]).not.toContain("Unsaved changes");
    expect(tabs[1]).toContain("Unsaved changes");
  });
});
