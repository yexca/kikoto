import { expect, test } from "@playwright/test";
import type { TranslationRun } from "../../src/lib/api";
import { syntheticWorkCode } from "../../src/test-support/workCode";
import { appSettingsFixture, fixtureTimestamp, type ApiResponse } from "./fixtures/api";
import { mockApplication } from "./fixtures/player-library";

test("A translator cancels an allowed run through Translation and cannot cancel another run", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write"],
  });
  await page.route("**/api/settings", (route) => route.fulfill({ json: appSettingsFixture() }));

  const runs: TranslationRun[] = [
    {
      runId: 1,
      status: "running",
      canCancel: true,
      workId: 1,
      workCode: syntheticWorkCode("RJ", 1),
      workTitle: "Example own translation",
      requestedBy: "Example User",
      createdAt: fixtureTimestamp,
      languages: [],
    },
    {
      runId: 2,
      status: "queued",
      canCancel: false,
      workId: 2,
      workCode: syntheticWorkCode("RJ", 2),
      workTitle: "Example other translation",
      requestedBy: "Example Translator",
      createdAt: fixtureTimestamp,
      languages: [],
    },
  ];
  const cancelled = new Set<number>();
  await page.route("**/api/translation/runs?*", (route) => {
    const view = new URL(route.request().url()).searchParams.get("view");
    const remaining = runs.filter((run) => !cancelled.has(run.runId));
    return route.fulfill({
      json: {
        runs: remaining.filter((run) => run.status === (view === "queued" ? "queued" : "running")),
        counts: {
          active: remaining.filter((run) => run.status === "running").length,
          queued: remaining.filter((run) => run.status === "queued").length,
          review: 0,
          attention: 0,
        },
        autoAccept: true,
      } satisfies ApiResponse<"listTranslationRuns">,
    });
  });
  const requested: number[] = [];
  await page.route("**/api/translation/runs/*/cancel", (route) => {
    expect(route.request().method()).toBe("POST");
    const runId = Number(new URL(route.request().url()).pathname.split("/").at(-2));
    requested.push(runId);
    cancelled.add(runId);
    return route.fulfill({
      json: { runId, status: "cancelled", message: "run cancelled" } satisfies ApiResponse<"cancelTranslationRun">,
    });
  });

  await page.goto("/translation?view=running");
  const own = page.getByRole("listitem").filter({ hasText: "Example own translation" });
  const other = page.getByRole("listitem").filter({ hasText: "Example other translation" });
  await expect(own.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await expect(other).toBeVisible();
  await expect(other.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);

  await own.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(() => requested).toEqual([runs[0].runId]);
  await expect(own).toHaveCount(0);
  await expect(other).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
});
