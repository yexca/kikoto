import { expect, test } from "@playwright/test";
import { mockApplication } from "./fixtures/player-library";

for (const layout of ["mobile", "@desktop"]) {
  test(`${layout} first metadata prompt waits for scan, starts once, and shows completion`, async ({ page }) => {
    await mockApplication(page, undefined, false, 1, 0, [], undefined, {
      authenticated: true,
      permissions: ["library:read", "metadata:sync", "workflows:run"],
    });
    let state = { status: "waiting", missingWorks: 0, runId: 0 };
    let starts = 0;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    await page.route("**/api/metadata/onboarding**", async (route) => {
      if (route.request().url().endsWith("/start")) {
        starts++;
        await startGate;
        state = { status: "queued", missingWorks: 0, runId: 42 };
      }
      await route.fulfill({ json: state });
    });
    await page.goto("/");
    const notice = page.getByRole("region", { name: "Metadata setup", exact: true });
    await expect(notice).toHaveCount(0);
    state = { status: "ready", missingWorks: 1, runId: 0 };
    await expect(notice).toBeVisible();
    const start = notice.getByRole("button", { name: "Sync metadata", exact: true });
    const bounds = await start.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    await start.click();
    await expect(start).toBeDisabled();
    releaseStart();
    await expect(notice).toContainText("Metadata sync in progress");
    expect(starts).toBe(1);
    await expect(notice.getByRole("button", { name: "View Activity" })).toBeVisible();
    state = { status: "succeeded", missingWorks: 0, runId: 42 };
    await expect(notice).toContainText("Metadata sync completed");
    await page.screenshot({ path: `test-results/metadata-onboarding-${layout.replace("@", "")}.png` });
  });
}

test("metadata prompt retains a retryable error and Later survives reload", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "metadata:sync"],
  });
  let dismissed = false;
  await page.route("**/api/metadata/onboarding**", async (route) => {
    if (route.request().url().endsWith("/start")) {
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
      return;
    }
    if (route.request().url().endsWith("/dismiss")) dismissed = true;
    await route.fulfill({ json: { status: dismissed ? "hidden" : "ready", missingWorks: 1, runId: 0 } });
  });
  await page.goto("/");
  const notice = page.getByRole("region", { name: "Metadata setup", exact: true });
  await notice.getByRole("button", { name: "Sync metadata", exact: true }).click();
  await expect(notice.getByRole("alert")).toBeVisible();
  await expect(notice.getByRole("button", { name: "Sync metadata", exact: true })).toBeEnabled();
  await notice.getByRole("button", { name: "Later", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("read-only users do not request the metadata prompt", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read"],
  });
  let requests = 0;
  await page.route("**/api/metadata/onboarding**", async (route) => {
    requests++;
    await route.fulfill({ status: 403, json: { error: "permission denied" } });
  });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("region", { name: "Metadata setup", exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
});

for (const canViewActivity of [true, false]) {
  test(`metadata failures link to recovery with workflow access ${canViewActivity}`, async ({ page }) => {
    await mockApplication(page, undefined, false, 1, 0, [], undefined, {
      authenticated: true,
      permissions: ["library:read", "metadata:sync", ...(canViewActivity ? ["workflows:run"] : [])],
    });
    await page.route("**/api/metadata/onboarding**", (route) =>
      route.fulfill({ json: { status: "partial", missingWorks: 1, runId: 42 } }),
    );
    await page.route("**/api/notifications?*", (route) =>
      route.fulfill({
        json: {
          notifications: [
            {
              id: 1,
              workflowRunId: 42,
              type: "metadata_onboarding",
              status: "failed",
              workId: null,
              fileSourceId: null,
              workCode: "",
              message: "",
              createdAt: "2026-01-01T00:00:00Z",
            },
          ],
          page: 1,
          pageSize: 20,
          total: 1,
        },
      }),
    );
    let lastRunFilter: string | null = null;
    await page.route("**/api/maintenance/works?*", async (route) => {
      lastRunFilter = new URL(route.request().url()).searchParams.get("runId");
      await route.fulfill({ json: { works: [], page: 1, pageSize: 25, total: 0 } });
    });
    const expected = canViewActivity ? /\/metadata\?reason=metadata&metadataRun=42$/ : /\/metadata\?reason=metadata$/;
    await page.goto("/");
    await page
      .getByRole("region", { name: "Metadata setup", exact: true })
      .getByRole("button", { name: "Open metadata issues", exact: true })
      .click();
    await expect(page).toHaveURL(expected);
    await expect(page.getByRole("heading", { name: "Metadata", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Metadata issues", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("button", { name: "Refresh list", exact: true })).toBeEnabled();
    expect(lastRunFilter).toBe(canViewActivity ? "42" : null);
    await page.goto("/");
    await page.getByRole("button", { name: "Notifications", exact: true }).click();
    await page.getByRole("button", { name: /Metadata sync needs attention.*Workflow/ }).click();
    await expect(page).toHaveURL(expected);
  });
}
