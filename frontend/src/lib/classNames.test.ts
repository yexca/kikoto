import { describe, expect, it } from "vitest";

import { cx } from "@/lib/classNames";
import { cn } from "@/lib/tailwindClassNames";

describe("class name helpers", () => {
  it("joins authored conditions without merging utility groups", () => {
    expect(cx("px-2", false, ["px-4", { "text-sm": true }])).toBe("px-2 px-4 text-sm");
  });

  it("keeps caller utility overrides at merge boundaries", () => {
    expect(cn("h-[var(--control-height)]", "h-11")).toBe("h-11");
    expect(cn("bg-card", "bg-error-surface")).toBe("bg-error-surface");
  });
});
