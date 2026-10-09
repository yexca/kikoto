import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LanguageControls } from "@/app/header/LanguageControls";

describe("LanguageControls", () => {
  const props = {
    localePreference: "auto",
    onLocaleChange: vi.fn(),
    localeBusy: false,
    localeError: "",
  } as const;

  it("offers only the UI language to anonymous visitors", () => {
    const rendered = renderToStaticMarkup(<LanguageControls {...props} />);
    expect(rendered).toContain('aria-label="UI language"');
    expect(rendered).not.toContain("Preferred metadata language");
  });

  it("places the metadata language directly below the UI language for a signed-in user", () => {
    const rendered = renderToStaticMarkup(
      <LanguageControls
        {...props}
        metadataLanguage={{ value: "origin", busy: false, failed: false, onChange: vi.fn() }}
      />,
    );
    const groups = [...rendered.matchAll(/role="group" aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(groups).toEqual(["UI language", "Preferred metadata language"]);
    expect(rendered).toContain(">Origin<");
  });
});
