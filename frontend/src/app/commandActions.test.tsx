import { describe, expect, it, vi } from "vitest";

import { commandActions } from "@/app/commandActions";
import { navItems } from "@/app/navigation";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
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
      followUpRun: false,
      newWorkCodes: [],
      failures: [],
    });
    const actions = commandActions({
      hasPermission: (permission) => permission === "workflows:run" || permission === "metadata:sync",
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

    expect(api.runLocalScan).toHaveBeenCalledWith({ followUpRun: false });
    expect(onOpenPath).toHaveBeenCalledWith("/activity");
  });
});
