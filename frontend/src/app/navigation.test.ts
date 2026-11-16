import { describe, expect, it } from "vitest";

import {
  canAccessPage,
  navigationGroups,
  navigationLabel,
  navItems,
  pageTurnedOff,
  visibleNavigationItems,
} from "./navigation";

describe("navigation access and labels", () => {
  it("orders the Manage group Workflows, Metadata, Translation, Cleanup, System", () => {
    expect(navItems.filter((item) => item.group === "manage").map((item) => item.id)).toEqual([
      "workflows",
      "metadata",
      "translation",
      "cleanup",
      "system",
    ]);
    expect(navItems.find((item) => item.id === "workflows")).toMatchObject({ label: "Workflows", path: "/workflows" });
    expect(navItems.find((item) => item.id === "cleanup")).toMatchObject({ label: "Cleanup", path: "/cleanup" });
  });
  it("offers Cleanup to holders of either cleanup permission", () => {
    expect(canAccessPage("cleanup", "authenticated", (permission) => permission === "downloads:manage")).toBe(true);
    expect(canAccessPage("cleanup", "authenticated", (permission) => permission === "sources:write")).toBe(true);
    expect(canAccessPage("cleanup", "authenticated", (permission) => permission === "metadata:sync")).toBe(false);
    expect(canAccessPage("cleanup", "anonymous", () => true)).toBe(false);
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

  it("offers Workflows, which holds every run, behind the workflow permission", () => {
    const visible = visibleNavigationItems({ state: "authenticated", hasPermission: () => true });
    expect(visible.find((item) => item.id === "workflows")).toMatchObject({ path: "/workflows", group: "manage" });
    expect(canAccessPage("workflows", "authenticated", (permission) => permission !== "workflows:run")).toBe(false);
  });

  it("places Insights, Tags, and Settings in Personal and closes the sidebar with About", () => {
    const groups = new Set<string>(["browse", "app", ...navigationGroups.map((group) => group.id)]);
    expect(navItems.every((item) => groups.has(item.group))).toBe(true);
    const grouped = (group: string) => navItems.filter((item) => item.group === group).map((item) => item.id);
    expect(grouped("personal")).toEqual(["insights", "tags", "settings"]);
    expect(grouped("app")).toEqual(["about"]);
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

  it("offers Record only while the instance has it on, and its address is not found while off", () => {
    const ids = (recordEnabled: boolean) =>
      visibleNavigationItems({ state: "authenticated", hasPermission: () => true, recordEnabled }).map(
        (item) => item.id,
      );
    expect(ids(false)).not.toContain("records");
    expect(ids(true)).toContain("records");
    expect(pageTurnedOff("records", { recordEnabled: false })).toBe(true);
    expect(pageTurnedOff("records", { recordEnabled: true })).toBe(false);
    expect(pageTurnedOff("library", { recordEnabled: false })).toBe(false);
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
