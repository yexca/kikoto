import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppearanceControls } from "@/app/AppearanceControls";
import { ThemePresetPicker } from "@/app/ThemePresetPicker";

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

  it("keeps each style preview's authored accent color", () => {
    const rendered = renderToStaticMarkup(<ThemePresetPicker value="anthropic" onChange={vi.fn()} />);
    for (const color of ["#ad4f2f", "#10a37f", "#007aff", "#1a73e8"]) {
      expect(rendered).toContain(`background-color:${color}`);
    }
  });
});
