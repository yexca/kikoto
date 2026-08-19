import { describe, expect, it } from "vitest";

import { canAccessPage, navigationDescription, navigationLabel, navItems, visibleNavigationItems } from "./navigation";

describe("navigation access and labels", () => {
  it("uses translated labels and falls back to authored copy for missing translations", () => {
    const item = navItems[0];
    expect(navigationLabel(item, (key) => `translated:${key}`)).toBe("translated:nav.library");
    expect(navigationDescription(item, (key) => key)).toBe(item.description);
  });

  it("hides authenticated and admin destinations from anonymous users", () => {
    const visible = visibleNavigationItems({ state: "anonymous", hasPermission: () => true });
    expect(visible.map((item) => item.id)).toEqual(["library", "circles", "voice-actors", "about"]);
  });

  it("requires the declared permission for admin destinations", () => {
    const noWorkflows = visibleNavigationItems({
      state: "authenticated",
      hasPermission: (permission) => permission !== "workflows:run",
    });
    expect(noWorkflows.map((item) => item.id)).not.toContain("workflows");
    expect(noWorkflows.map((item) => item.id)).toContain("maintenance");

    expect(canAccessPage("settings", "anonymous", () => true)).toBe(false);
    expect(canAccessPage("workflows", "authenticated", () => false)).toBe(false);
    expect(canAccessPage("workflows", "authenticated", () => true)).toBe(true);
    expect(canAccessPage("library", "anonymous", () => false)).toBe(true);
    expect(canAccessPage("unknown" as never, "anonymous", () => false)).toBe(true);
  });
});
