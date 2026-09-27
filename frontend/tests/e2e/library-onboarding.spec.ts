import { expect, test } from "@playwright/test";

import type { LegacyWorkflowMigrationItem, LibraryLayout } from "../../src/lib/api";
import { mockApplication } from "./fixtures/player-library";

for (const hasLegacyWorkflows of [false, true]) {
  test(`library onboarding ${hasLegacyWorkflows ? "reviews preserved workflows" : "skips workflow review for a fresh library"} @desktop`, async ({
    page,
  }) => {
    await mockApplication(page, undefined, false, 0, 0, [], undefined, {
      authenticated: true,
      permissions: ["library:read", "sources:write"],
    });
    await page.route("**/api/library/migration/public", (route) => route.fulfill({ json: { maintenance: false } }));
    await page.route("**/api/library/layout", (route) =>
      route.fulfill({
        json: {
          mode: "standard",
          configured: true,
          locked: false,
          onboardingCompleted: false,
          hasLegacyWorkflows,
          pools: [],
          candidates: [],
          fetchPool: "",
          localScanTriggers: { startupScan: false, watchFolders: false },
        } satisfies LibraryLayout,
      }),
    );
    const legacyWorkflows: LegacyWorkflowMigrationItem[] = hasLegacyWorkflows
      ? [{ id: 1, name: "Example workflow", reviewStatus: "pending", triggerCount: 1, canConvert: false }]
      : [];
    let reviewRequests = 0;
    await page.route("**/api/library/legacy-workflows", (route) => {
      reviewRequests++;
      return route.fulfill({ json: legacyWorkflows });
    });

    await page.goto("/");
    const setup = page.getByRole("dialog", { name: "Set up your library" });
    await expect(setup).toBeVisible();
    await setup.getByRole("button", { name: "Keep current mode and continue" }).click();
    await expect(setup.getByRole("heading", { name: "Scan the library" })).toBeVisible();
    await setup.getByRole("button", { name: "Skip" }).click();

    if (hasLegacyWorkflows) {
      await expect(setup.getByRole("heading", { name: "Review earlier custom workflows" })).toBeVisible();
      await expect(setup).toContainText("Step 3 of 5");
      await expect(setup.getByText("Example workflow")).toBeVisible();
      expect(reviewRequests).toBeGreaterThan(0);
    } else {
      await expect(setup.getByRole("heading", { name: "Sync metadata" })).toBeVisible();
      await expect(setup).toContainText("Step 3 of 4");
      expect(reviewRequests).toBe(0);
    }
  });
}
