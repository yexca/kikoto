import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppearanceControls } from "@/app/AppearanceControls";

describe("AppearanceControls", () => {
  it("labels mode, style, and color as separate appearance groups", () => {
    const rendered = renderToStaticMarkup(
      <AppearanceControls
        mode="system"
        preset="anthropic"
        palette="original"
        onModeChange={vi.fn()}
        onPresetChange={vi.fn()}
        onPaletteChange={vi.fn()}
      />,
    );

    for (const label of ["Mode", "Style", "Color"]) {
      expect(rendered).toContain(`role="group" aria-label="${label}"`);
    }
    expect(rendered).toContain('aria-label="UI language"');
    expect(rendered).toContain('aria-label="Mode"');
    expect(rendered.match(/role="combobox"/g)).toHaveLength(2);
  });

  it("places the metadata language directly below the UI language only when provided", () => {
    const props = {
      mode: "system",
      preset: "anthropic",
      palette: "original",
      onModeChange: vi.fn(),
      onPresetChange: vi.fn(),
      onPaletteChange: vi.fn(),
    } as const;
    expect(renderToStaticMarkup(<AppearanceControls {...props} />)).not.toContain("Preferred metadata language");

    const rendered = renderToStaticMarkup(
      <AppearanceControls
        {...props}
        metadataLanguage={{ value: "origin", busy: false, failed: false, readOnly: false, onChange: vi.fn() }}
      />,
    );
    const groups = [...rendered.matchAll(/role="group" aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(groups.slice(0, 3)).toEqual(["UI language", "Preferred metadata language", "Mode"]);
    expect(rendered).toContain(">Origin<");
  });
});
