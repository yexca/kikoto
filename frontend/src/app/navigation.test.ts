import { describe, expect, it } from "vitest";

import { canAccessPage, navigationGroups, navigationLabel, navItems, visibleNavigationItems } from "./navigation";

describe("navigation access and labels", () => {
  it("orders the Manage group Workflows, Activity, Metadata, Translation, System", () => {
    expect(navItems.filter((item) => item.group === "manage").map((item) => item.id)).toEqual([
      "workflows",
      "activity",
      "metadata",
      "translation",
      "system",
    ]);
    expect(navItems.find((item) => item.id === "workflows")).toMatchObject({ label: "Workflows", path: "/workflows" });
  });
  it("lets metadata operators reach work management without source settings permission", () => {
    expect(canAccessPage("metadata", "authenticated", (permission) => permission === "metadata:sync")).toBe(true);
    expect(canAccessPage("metadata", "authenticated", (permission) => permission === "library:write")).toBe(true);
    expect(canAccessPage("metadata", "authenticated", () => false)).toBe(false);
    expect(canAccessPage("metadata", "anonymous", () => true)).toBe(false);
  });
  it("uses translated labels and falls back to authored copy for missing translations", () => {
    const item = navItems[0];
    expect(navigationLabel(item, (key) => `translated:${key}`)).toBe("translated:nav.library");
    expect(navigationLabel(item, (key) => key)).toBe(item.label);
  });

  it("offers Activity as a Manage destination behind the workflow permission", () => {
    const visible = visibleNavigationItems({ state: "authenticated", hasPermission: () => true });
    expect(visible.find((item) => item.id === "activity")).toMatchObject({ path: "/activity", group: "manage" });
    expect(canAccessPage("activity", "authenticated", (permission) => permission !== "workflows:run")).toBe(false);
  });

  it("offers every destination in a sidebar group or, without one, in the account panel", () => {
    const groups = new Set<string | undefined>(["browse", ...navigationGroups.map((group) => group.id)]);
    expect(navItems.filter((item) => !groups.has(item.group)).map((item) => item.id)).toEqual(["about"]);
    const grouped = (group: string) => navItems.filter((item) => item.group === group).map((item) => item.id);
    expect(grouped("personal")).toEqual(["insights", "tags", "settings"]);
  });

  it("shows System by role, whatever the permissions, and Tags to library readers", () => {
    const visible = visibleNavigationItems({ state: "authenticated", hasPermission: () => true });
    expect(visible.map((item) => item.id)).toContain("tags");
    expect(visible.map((item) => item.id)).not.toContain("system");
    expect(
      visibleNavigationItems({ state: "authenticated", hasPermission: () => false, administrator: true }).map(
        (item) => item.id,
      ),
    ).toContain("system");
    expect(canAccessPage("system", "authenticated", () => true)).toBe(false);
    expect(canAccessPage("system", "authenticated", () => false, true)).toBe(true);
    expect(canAccessPage("system", "anonymous", () => true, true)).toBe(false);
    expect(canAccessPage("tags", "authenticated", () => false)).toBe(false);
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
    expect(noWorkflows.map((item) => item.id)).not.toContain("maintenance");

    expect(canAccessPage("settings", "anonymous", () => true)).toBe(false);
    expect(canAccessPage("workflows", "authenticated", () => false)).toBe(false);
    expect(canAccessPage("workflows", "authenticated", () => true)).toBe(true);
    expect(canAccessPage("library", "anonymous", () => false)).toBe(true);
    expect(canAccessPage("unknown" as never, "anonymous", () => false)).toBe(true);
  });
});
