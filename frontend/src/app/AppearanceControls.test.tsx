import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";
import { AppearanceControls } from "@/app/AppearanceControls";

describe("AppearanceControls", () => {
  it("labels mode, style, and color as separate appearance groups without language choices", () => {
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

    const groups = [...rendered.matchAll(/role="group" aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(groups).toEqual(["Mode", "Style", "Color"]);
    expect(rendered).not.toContain("UI language");
    expect(rendered.match(/role="combobox"/g)).toHaveLength(1);
  });
});
