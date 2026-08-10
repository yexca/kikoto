import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeTrigger } from "@/app/ThemeTrigger";

const triggerProps = {
  preset: "anthropic" as const,
  palette: "original" as const,
};

describe("ThemeTrigger", () => {
  it("uses the fixed palette icon for every display mode", () => {
    const markup = (["light", "dark", "system"] as const).map((mode) =>
      renderToStaticMarkup(<ThemeTrigger {...triggerProps} mode={mode} />),
    );

    for (const rendered of markup) {
      expect(rendered).toContain("lucide-palette");
      expect(rendered).not.toContain("lucide-sun");
      expect(rendered).not.toContain("lucide-moon");
    }
  });

  it("describes the control as an appearance settings entry point", () => {
    const rendered = renderToStaticMarkup(<ThemeTrigger {...triggerProps} mode="system" />);

    expect(rendered).toContain('aria-label="Open appearance settings"');
    expect(rendered).toContain("Appearance: System, Anthropic, Original");
  });
});
