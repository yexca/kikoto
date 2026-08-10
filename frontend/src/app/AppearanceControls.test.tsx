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
      expect(rendered).toContain(`>${label}</div>`);
    }
  });
});
