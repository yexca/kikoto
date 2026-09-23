import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as typeof globalThis & { __APP_VERSION__: string }).__APP_VERSION__ = "test";
});

import "@/i18n";
import { SeekBar } from "./playerControls";

describe("SeekBar", () => {
  it("announces the position as elapsed of total time instead of raw seconds", () => {
    const rendered = renderToStaticMarkup(<SeekBar currentTime={83.4} duration={296} onSeek={() => undefined} />);

    expect(rendered).toContain('aria-label="Seek"');
    expect(rendered).toContain('aria-valuetext="1:23 of 4:56"');
  });

  it("omits the position text while the duration is unknown", () => {
    const rendered = renderToStaticMarkup(<SeekBar currentTime={0} duration={Number.NaN} onSeek={() => undefined} />);

    expect(rendered).not.toContain("aria-valuetext");
  });
});
