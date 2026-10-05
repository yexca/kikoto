import { expect, test, type Page } from "@playwright/test";
import { mockApplication, work } from "./fixtures/player-library";
import { metadataCircleFixture, metadataTagFixture, workDetailFixture, type ApiResponse } from "./fixtures/api";
import type { CircleMergeReview, MetadataTagOverride, WorkMetadataTags } from "../../src/lib/api";

async function metadataWorkEditor(page: Page) {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write", "playback:use"],
  });
  await page.route("**/api/maintenance/works?*", (route) =>
    route.fulfill({
      json: {
        works: [
          {
            ...work,
            id: 1,
            primaryCode: work.primaryCode,
            title: "Synthetic metadata work",
            circle: "",
            noSource: false,
            metadataIssues: [],
          },
        ],
        total: 1,
        page: 1,
        pageSize: 25,
      } satisfies ApiResponse<"listMaintenanceWorks">,
    }),
  );
  await page.route("**/api/works/1?includeMedia=false", (route) =>
    route.fulfill({ json: workDetailFixture({ ...work, title: "Synthetic metadata work" }, { manualOverrides: {} }) }),
  );
  await page.route("**/api/works/1/cover-candidates", (route) =>
    route.fulfill({ json: { candidates: [] } satisfies ApiResponse<"listWorkCoverCandidates"> }),
  );
}

test("@desktop cover-only metadata saves do not freeze any displayed scalar fields", async ({ page }) => {
  await metadataWorkEditor(page);
  await page.route("**/api/works/1/cover-candidates", (route) =>
    route.fulfill({
      json: {
        candidates: [
          {
            locationId: 7,
            fileName: "cover.png",
            path: `${work.primaryCode}/cover.png`,
            previewUrl: "/synthetic-cover.png",
            sizeBytes: 128,
            selected: false,
          },
        ],
      } satisfies ApiResponse<"listWorkCoverCandidates">,
    }),
  );
  const scalarWrites: unknown[] = [];
  await page.route("**/api/works/1/manual-overrides", (route) => {
    scalarWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  let cover: unknown;
  await page.route("**/api/works/1/cover-override", (route) => {
    cover = route.request().postDataJSON();
    return route.fulfill({ json: {} });
  });
  await page.goto("/metadata");
  await page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByRole("button", { name: /cover.png/ }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(cover).toEqual({ locationId: 7 });
  expect(scalarWrites).toEqual([]);
});

test("work tag edits autocomplete, create, remove and reset without scalar writes", async ({ page }) => {
  await metadataWorkEditor(page);
  const inherited = metadataTagFixture({ id: 2, displayName: "Synthetic inherited tag" });
  const shared = metadataTagFixture({ id: 3, displayName: "Synthetic shared tag" });
  const created = metadataTagFixture({ id: 4, displayName: "Synthetic new tag" });
  let state: WorkMetadataTags = { tags: [{ ...inherited }], inheritedTags: [{ ...inherited }], overrides: [] };
  const writes: { overrides: MetadataTagOverride[]; newTags?: string[] }[] = [];
  let releaseSaved!: () => void;
  const savedReady = new Promise<void>((resolve) => {
    releaseSaved = resolve;
  });
  await page.route("**/api/works/1/metadata-tags", async (route) => {
    if (route.request().method() === "PUT") {
      const payload = route.request().postDataJSON() as { overrides: MetadataTagOverride[]; newTags?: string[] };
      writes.push(payload);
      await savedReady;
      const overrides = payload.newTags?.length
        ? [...payload.overrides, { tagId: created.id, action: "add" as const }]
        : payload.overrides;
      state = { ...state, overrides, tags: overrides.length ? [{ ...shared }, { ...created }] : state.inheritedTags };
    }
    return route.fulfill({ json: state });
  });
  await page.route("**/api/metadata/tags?*", (route) =>
    route.fulfill({
      json: { tags: [shared], total: 1, page: 1, pageSize: 20 } satisfies ApiResponse<"listMetadataTags">,
    }),
  );
  let sharedCreates = 0;
  await page.route("**/api/metadata/tags", (route) => {
    sharedCreates++;
    return route.fulfill({ json: created });
  });
  const scalarWrites: unknown[] = [];
  await page.route("**/api/works/1/manual-overrides", (route) => {
    scalarWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.goto("/metadata");
  const open = () => page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  await open();
  let dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByRole("button", { name: "Remove Synthetic inherited tag" }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill("Synthetic shared");
  await dialog.getByRole("button", { name: "Synthetic shared tag", exact: true }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill("Synthetic new tag");
  await dialog.getByRole("button", { name: "Create tag: Synthetic new tag", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove Synthetic new tag" })).toBeVisible();
  expect(writes).toEqual([]);
  expect(sharedCreates).toBe(0);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /^Saving/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  releaseSaved();
  await expect(dialog).toHaveCount(0);
  expect(writes[0]).toEqual({
    overrides: [
      { tagId: 2, action: "remove" },
      { tagId: 3, action: "add" },
    ],
    newTags: ["Synthetic new tag"],
  });
  expect(sharedCreates).toBe(0);
  expect(scalarWrites).toEqual([]);
  await open();
  dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByRole("button", { name: "Restore DLsite tags" }).click();
  await expect(dialog.getByRole("button", { name: "Remove Synthetic inherited tag" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1]).toEqual({ overrides: [] });
});

test("canceling staged tags writes nothing and exact names reuse autocomplete entries", async ({ page }) => {
  await metadataWorkEditor(page);
  const existing = metadataTagFixture({
    id: 3,
    displayName: "Synthetic display tag",
    names: [{ language: "en-us", name: "Synthetic alternate name", source: "manual" }],
  });
  let writes = 0;
  await page.route("**/api/works/1/metadata-tags", (route) => {
    if (route.request().method() === "PUT") writes++;
    return route.fulfill({ json: { tags: [], inheritedTags: [], overrides: [] } satisfies WorkMetadataTags });
  });
  await page.route("**/api/metadata/tags", (route) => {
    writes++;
    return route.fulfill({ json: existing });
  });
  await page.route("**/api/metadata/tags?*", (route) =>
    route.fulfill({
      json: { tags: [existing], total: 1, page: 1, pageSize: 20 } satisfies ApiResponse<"listMetadataTags">,
    }),
  );
  await page.goto("/metadata");
  const open = () => page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  await open();
  let dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByLabel("Add tag", { exact: true }).fill("Synthetic draft tag");
  await dialog.getByRole("button", { name: "Create tag: Synthetic draft tag", exact: true }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill(" synthetic DRAFT tag ");
  await expect(dialog.getByRole("button", { name: /Create tag:/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Remove Synthetic draft tag", exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(0);
  await open();
  dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await expect(dialog.getByRole("button", { name: "Remove Synthetic draft tag", exact: true })).toHaveCount(0);
  await dialog.getByLabel("Add tag", { exact: true }).fill(" synthetic ALTERNATE name ");
  await expect(dialog.getByRole("button", { name: "Synthetic display tag", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Create tag:/ })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Synthetic display tag", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove Synthetic display tag", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(writes).toBe(0);
});

test("@desktop shared tag dialog edits names and reviews reversible merges", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write"],
  });
  let entry = metadataTagFixture();
  const target = metadataTagFixture({ id: 2, key: "custom:synthetic-target", displayName: "Synthetic target tag" });
  await page.route("**/api/metadata/tags?*", (route) =>
    route.fulfill({
      json: {
        tags: [entry, target],
        total: 2,
        page: 1,
        pageSize: 25,
        pendingWorkCount: entry.pendingWorkCount,
      } satisfies ApiResponse<"listMetadataTags">,
    }),
  );
  const changes: unknown[] = [];
  await page.route("**/api/metadata/tags/1", (route) => {
    const payload = route.request().postDataJSON() as { names?: Record<string, string>; hidden?: boolean };
    changes.push(payload);
    entry = {
      ...entry,
      hidden: payload.hidden ?? entry.hidden,
      displayName: payload.names?.[""] || entry.displayName,
      names: payload.names?.[""] ? [{ language: "", name: payload.names[""], source: "manual" }] : entry.names,
    };
    return route.fulfill({ json: entry });
  });
  let merge: unknown;
  await page.route("**/api/metadata/tags/1/merge", (route) => {
    if (route.request().method() !== "DELETE") merge = route.request().postDataJSON();
    entry = { ...entry, mergedIntoTagId: route.request().method() === "DELETE" ? null : 2, pendingWorkCount: 70 };
    return route.fulfill({ json: entry });
  });
  await page.goto("/metadata?view=tags");
  await expect(page.getByRole("tab", { name: "Tags", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Manage Synthetic tag", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/its manual name, then the all-language manual name/)).toBeVisible();
  await dialog.getByLabel("All languages", { exact: true }).fill("Authored tag name");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Manage Authored tag name");
  expect(changes[0]).toEqual({ names: { "": "Authored tag name" } });
  await dialog.getByLabel("Merge target", { exact: true }).fill("Synthetic target");
  await dialog.getByRole("button", { name: "Synthetic target tag", exact: true }).click();
  await expect(dialog.getByText(/Work tags will use the target/)).toBeVisible();
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Undo merge" })).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("70 works");
  expect(merge).toEqual({ targetTagId: 2 });
  await dialog.getByRole("button", { name: "Undo merge" }).click();
  await expect(dialog.getByLabel("Merge target", { exact: true })).toBeVisible();
  await dialog.getByLabel("Hide this tag everywhere").check();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => changes.length).toBe(2);
  expect(changes[1]).toEqual({ names: {}, hidden: true });
  await page.screenshot({ path: "test-results/metadata-tag-management.png", fullPage: true });
});

test("hidden tag matches are explained and cannot be silently created in the work editor", async ({ page }) => {
  await metadataWorkEditor(page);
  const hidden = metadataTagFixture({ displayName: "Example hidden tag", hidden: true, resolvedHidden: true });
  await page.route("**/api/metadata/tags?*", (route) => {
    expect(new URL(route.request().url()).searchParams.get("includeHidden")).toBe("true");
    return route.fulfill({
      json: { tags: [hidden], total: 1, page: 1, pageSize: 20 } satisfies ApiResponse<"listMetadataTags">,
    });
  });
  await page.goto("/metadata");
  await page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByLabel("Add tag", { exact: true }).fill("Example hidden tag");
  await expect(dialog.getByRole("button", { name: "Example hidden tag · Hidden", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toContainText("Unhide it in Metadata");
  await expect(dialog.getByRole("button", { name: "Create tag: Example hidden tag", exact: true })).toHaveCount(0);
});

test("tag creation conflicts retain the name and explain the hidden target", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write"],
  });
  await page.route("**/api/metadata/tags?*", (route) =>
    route.fulfill({
      json: {
        tags: [],
        total: 0,
        page: 1,
        pageSize: 25,
        pendingWorkCount: 3,
      } satisfies ApiResponse<"listMetadataTags">,
    }),
  );
  await page.route("**/api/metadata/tags", (route) =>
    route.fulfill({
      status: 409,
      json: { code: "metadata_tag_hidden", error: "synthetic conflict", retryable: false },
    }),
  );
  await page.goto("/metadata?view=tags");
  await expect(page.getByRole("status")).toContainText("3 works");
  await page.getByRole("button", { name: "Create tag", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Tag name").fill("Example hidden tag");
  await dialog.getByRole("button", { name: "Create tag", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Unhide it in Metadata");
  await expect(dialog.getByLabel("Tag name")).toHaveValue("Example hidden tag");
});

test("circle management keeps names and aliases and reviews merge history", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write"],
  });
  let circle = metadataCircleFixture();
  const source = metadataCircleFixture({
    id: 2,
    displayName: "Synthetic second circle",
    providerName: "Synthetic second circle",
    externalIds: ["RG00000001"],
  });
  let history: CircleMergeReview[] = [];
  await page.route("**/api/metadata/circles?*", (route) =>
    route.fulfill({
      json: { circles: [circle, source], total: 2, page: 1, pageSize: 25 } satisfies ApiResponse<"listMetadataCircles">,
    }),
  );
  await page.route("**/api/metadata/circles/1", (route) => {
    if (route.request().method() === "PATCH") {
      const { manualName } = route.request().postDataJSON() as { manualName: string };
      circle = { ...circle, manualName, displayName: manualName || circle.providerName };
    }
    return route.fulfill({ json: circle });
  });
  await page.route("**/api/metadata/circles/1/aliases", (route) => {
    const { alias } = route.request().postDataJSON() as { alias: string };
    circle = { ...circle, aliases: [{ id: 1, alias, source: "manual" }] };
    return route.fulfill({ json: circle });
  });
  await page.route("**/api/metadata/circles/1/merges", (route) => route.fulfill({ json: history }));
  let merge: unknown;
  await page.route("**/api/metadata/circles/1/merge", (route) => {
    merge = route.request().postDataJSON();
    history = [
      {
        id: 1,
        targetPartyId: 1,
        sourcePartyId: 2,
        targetName: circle.displayName,
        sourceName: source.displayName,
        status: "merged",
        createdAt: "2026-01-01",
        undoneAt: "",
      },
    ];
    return route.fulfill({ json: { ok: true, mergeId: 1 } });
  });
  let undone = false;
  await page.route("**/api/metadata/circles/1/merges/1/undo", (route) => {
    undone = true;
    history = [{ ...history[0], status: "undone", undoneAt: "2026-01-02" }];
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/metadata?view=circles");
  await page.getByRole("button", { name: "Manage Synthetic circle", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Manual name", { exact: true }).fill("Authored circle");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("Manage Authored circle");
  await dialog.getByLabel("Alias", { exact: true }).fill("Synthetic circle alias");
  await dialog.getByRole("button", { name: "Add alias", exact: true }).click();
  await expect(dialog.getByText("Synthetic circle alias", { exact: true })).toBeVisible();
  await dialog.getByLabel("Merge", { exact: true }).fill("Synthetic second");
  await dialog.getByRole("button", { name: "Synthetic second circle", exact: true }).click();
  await expect(dialog.getByText(/personal circle data will move together/)).toBeVisible();
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Undo merge", exact: true })).toBeVisible();
  expect(merge).toEqual({ sourcePartyId: 2 });
  await dialog.getByRole("button", { name: "Undo merge", exact: true }).click();
  await expect.poll(() => undone).toBe(true);
  await expect(dialog.getByRole("button", { name: "Undo merge", exact: true })).toHaveCount(0);
});
