import { describe, expect, it, vi } from "vitest";

import { commandActions } from "@/app/commandActions";
import { type NavigationItem, navItems } from "@/app/navigation";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    queueRecordScan: vi.fn(),
    recoverStaleWorkflowRuns: vi.fn(),
    runDLsiteSync: vi.fn(),
    runLocalScan: vi.fn(),
  },
}));

const navigation = [navItems[0]];

describe("commandActions", () => {
  it("hides maintenance commands without the required permissions", () => {
    const actions = commandActions({
      hasPermission: () => false,
      visibleNavItems: navigation,
      onOpenPage: vi.fn(),
      onOpenPath: vi.fn(),
    });

    expect(actions.map((action) => action.id)).toEqual(["page:library"]);
  });

  it("lists the maintenance commands and activity navigation in Demo", () => {
    const actions = commandActions({
      hasPermission: () => false,
      canView: () => true,
      visibleNavItems: navigation,
      onOpenPage: vi.fn(),
      onOpenPath: vi.fn(),
    });

    expect(actions.map((action) => action.id)).toEqual([
      "action:local_scan",
      "action:dlsite_sync",
      "action:recover_stale",
      "page:library",
      "activity:attention",
      "activity:history",
    ]);
  });

  it("offers Your data beside Settings as its own destination to library readers", () => {
    const onOpenPath = vi.fn();
    const settings = navItems.filter((item) => item.id === "settings");
    const actions = commandActions({
      hasPermission: (permission) => permission === "library:read",
      visibleNavItems: settings,
      onOpenPage: vi.fn(),
      onOpenPath,
    });

    expect(actions.map((action) => action.label)).toEqual(["Settings", "Your data"]);
    actions[1].run();
    expect(onOpenPath).toHaveBeenCalledWith("/settings?tab=data");
    expect(
      commandActions({ hasPermission: () => false, visibleNavItems: settings, onOpenPage: vi.fn(), onOpenPath }),
    ).toHaveLength(1);
  });

  it("puts maintenance commands before navigation and runs a local scan through the shared command", async () => {
    const onOpenPath = vi.fn();
    vi.mocked(api.runLocalScan).mockResolvedValue({
      runId: 1,
      jobId: 2,
      fileSourceId: 3,
      status: "queued",
      detectedWorks: 0,
      scannedFiles: 0,
      updatedLocations: 0,
      skippedLocations: 0,
      newWorkCodes: [],
      failures: [],
    });
    // The administrator role's permissions.
    const administrator = new Set([
      ...["library:read", "playback:use", "favorites:write", "tags:write", "library:write", "sources:write"],
      ...["workflows:run", "metadata:sync", "downloads:manage", "remote:track", "remote:fetch", "users:manage"],
    ]);
    const actions = commandActions({
      hasPermission: (permission) => administrator.has(permission),
      visibleNavItems: navigation,
      onOpenPage: vi.fn(),
      onOpenPath,
    });

    expect(actions.slice(0, 3).map((action) => action.id)).toEqual([
      "action:local_scan",
      "action:dlsite_sync",
      "action:recover_stale",
    ]);

    await actions[0].run();

    expect(api.runLocalScan).toHaveBeenCalledWith();
    expect(onOpenPath).toHaveBeenCalledWith("/workflows?run=1");
  });

  it("offers a Record scan only while Record is listed, opening the run when workflows are visible", async () => {
    vi.mocked(api.queueRecordScan).mockResolvedValue({ runId: 7, jobId: 8, status: "queued" });
    const records = navItems.filter((item) => item.id === "records");
    const writer = (extra: string[]) => {
      const granted = new Set(["library:read", "library:write", ...extra]);
      return (permission: string) => granted.has(permission);
    };
    const build = (
      hasPermission: (permission: string) => boolean,
      visibleNavItems: readonly NavigationItem[] = records,
    ) => {
      const onOpenPage = vi.fn();
      const onOpenPath = vi.fn();
      const actions = commandActions({ hasPermission, visibleNavItems, onOpenPage, onOpenPath });
      return { action: actions.find((item) => item.id === "action:record_scan"), onOpenPage, onOpenPath };
    };

    expect(build(writer([]), navigation).action).toBeUndefined();
    expect(build(() => false).action).toBeUndefined();

    const withRuns = build(writer(["workflows:run"]));
    await withRuns.action?.run();
    expect(withRuns.onOpenPath).toHaveBeenCalledWith("/workflows?run=7");

    const withoutRuns = build(writer([]));
    await withoutRuns.action?.run();
    expect(withoutRuns.onOpenPage).toHaveBeenCalledWith("records");
    expect(api.queueRecordScan).toHaveBeenCalledTimes(2);
  });
});
