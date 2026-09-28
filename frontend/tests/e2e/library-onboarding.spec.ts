import { expect, test } from "@playwright/test";

import type {
  LegacyWorkflowMigrationItem,
  LibraryLayout,
  LibraryMigrationPreview,
  LibraryMigrationStatus,
} from "../../src/lib/api";
import { workflowRunDetailFixture, workflowRunFixture } from "./fixtures/api";
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
    await setup.getByRole("button", { name: "Next", exact: true }).click();
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

function libraryLayout(overrides: Partial<LibraryLayout> = {}): LibraryLayout {
  return {
    mode: "standard",
    configured: true,
    locked: false,
    onboardingCompleted: false,
    hasLegacyWorkflows: false,
    pools: [],
    candidates: ["Example Pool"],
    fetchPool: "",
    localScanTriggers: { startupScan: false, watchFolders: false },
    ...overrides,
  };
}

test("storage migration explains unresolved Fetch data and retains selections for retry @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 0, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "sources:write"],
  });
  await page.route("**/api/library/migration/public", (route) => route.fulfill({ json: { maintenance: false } }));
  await page.route("**/api/library/layout", (route) => route.fulfill({ json: libraryLayout() }));
  let blocked = true;
  await page.route("**/api/library/migration/preview", (route) =>
    blocked
      ? route.fulfill({
          status: 400,
          json: { code: "transaction_unresolved", error: "Protected diagnostic details", retryable: false },
        })
      : route.fulfill({
          json: { hash: "synthetic-preview", mode: "pools", moveCount: 0, bytes: 0 } satisfies LibraryMigrationPreview,
        }),
  );

  await page.goto("/");
  const setup = page.getByRole("dialog", { name: "Set up your library" });
  await setup.getByRole("radio", { name: "Storage pools", exact: true }).click();
  const pool = setup.getByRole("checkbox", { name: "Use Example Pool as a storage pool" });
  await pool.check();
  await setup.getByRole("button", { name: "Save and continue" }).click();
  await expect(setup.getByRole("alert")).toContainText("Unresolved Fetch files are blocking the storage change.");
  await expect(setup.getByRole("alert")).toContainText("especially after restoring a backup");
  await expect(page.getByText("Protected diagnostic details")).toHaveCount(0);
  await expect(pool).toBeChecked();

  blocked = false;
  await setup.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("dialog", { name: "Move library storage?" })).toBeVisible();
  await expect(setup.getByRole("alert")).toHaveCount(0);
});

test("fresh library saves its initial layout before continuing @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 0, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "sources:write"],
  });
  await page.route("**/api/library/migration/public", (route) => route.fulfill({ json: { maintenance: false } }));
  const updates: unknown[] = [];
  await page.route("**/api/library/layout", (route) => {
    if (route.request().method() === "PUT") {
      updates.push(route.request().postDataJSON());
      return route.fulfill({ json: libraryLayout() });
    }
    return route.fulfill({ json: libraryLayout({ mode: "", configured: false }) });
  });

  await page.goto("/");
  const setup = page.getByRole("dialog", { name: "Set up your library" });
  await setup.getByRole("button", { name: "Save and continue" }).click();
  await expect(setup.getByRole("heading", { name: "Scan the library" })).toBeVisible();
  expect(updates).toEqual([{ mode: "standard" }]);
});

test("upgraded library continues with unchanged storage and after a pool migration @desktop", async ({ page }) => {
  await mockApplication(page, undefined, false, 0, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "sources:write"],
  });
  let layout = libraryLayout();
  let maintenance = false;
  let layoutWrites = 0;
  const previews: unknown[] = [];
  const migrations: unknown[] = [];
  await page.route("**/api/library/layout", (route) => {
    if (route.request().method() !== "GET") layoutWrites++;
    return route.fulfill({ json: layout });
  });
  await page.route("**/api/library/migration/public", (route) => route.fulfill({ json: { maintenance } }));
  await page.route("**/api/library/migration/preview", (route) => {
    previews.push(route.request().postDataJSON());
    return route.fulfill({
      json: { hash: "synthetic-preview", mode: "pools", moveCount: 0, bytes: 0 } satisfies LibraryMigrationPreview,
    });
  });
  await page.route("**/api/library/migration", (route) => {
    if (route.request().method() === "POST") {
      migrations.push(route.request().postDataJSON());
      maintenance = true;
    }
    return route.fulfill({ json: { status: "running", phase: "copy" } satisfies LibraryMigrationStatus });
  });
  await page.route("**/api/workflow-runs/51", (route) =>
    route.fulfill({
      json: workflowRunDetailFixture(workflowRunFixture({ id: 51, summaryJson: '{"detected_works":1}' })),
    }),
  );
  await page.route("**/api/workflow-runs/51/events", (route) => route.fulfill({ json: [] }));

  await page.goto("/");
  const setup = page.getByRole("dialog", { name: "Set up your library" });
  await setup.getByRole("button", { name: "Next", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "Scan the library" })).toBeVisible();
  expect(layoutWrites).toBe(0);

  await page.reload();
  await setup.getByRole("radio", { name: "Storage pools", exact: true }).click();
  await expect(setup.getByRole("button", { name: "Save and continue" })).toBeDisabled();
  await setup.getByRole("checkbox", { name: "Use Example Pool as a storage pool" }).check();
  await setup.getByRole("combobox", { name: "Fetch pool", exact: true }).click();
  await page.getByRole("option", { name: "/data/Example Pool", exact: true }).click();
  await setup.getByRole("button", { name: "Save and continue" }).click();
  const confirmation = page.getByRole("dialog", { name: "Move library storage?" });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Works already inside the selected storage pools stay in place.");
  await expect(confirmation).toContainText(
    "Works outside the selected pools move into the Fetch pool /data/Example Pool",
  );
  await expect(confirmation).toContainText("Unrelated files and folders stay where they are.");
  expect(previews).toEqual([{ mode: "pools", pools: ["Example Pool"], fetchPool: "Example Pool" }]);
  expect(migrations).toEqual([]);
  await confirmation.getByRole("button", { name: "Start migration" }).click();
  await expect(page.getByRole("heading", { name: /under maintenance/i })).toBeVisible();
  expect(migrations).toEqual([
    { layout: { mode: "pools", pools: ["Example Pool"], fetchPool: "Example Pool" }, hash: "synthetic-preview" },
  ]);

  layout = libraryLayout({
    mode: "pools",
    fetchPool: "Example Pool",
    pools: [{ path: "Example Pool", online: true, canReconnect: false }],
    migrationScanRunId: 51,
  });
  maintenance = false;
  await expect(setup).toBeVisible();
  await expect(setup.getByRole("radio", { name: "Storage pools", exact: true })).toBeChecked();
  await setup.getByRole("button", { name: "Next", exact: true }).click();
  await expect(setup.getByRole("status")).toHaveText("Found 1 work.");
  await setup.getByRole("button", { name: "Next", exact: true }).click();
  await expect(setup.getByRole("heading", { name: "Sync metadata" })).toBeVisible();
  expect(layoutWrites).toBe(0);
  expect(migrations).toHaveLength(1);
});
