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

test("language title rows use source placeholders and stage reverts beside other drafts", async ({ page }) => {
  await metadataWorkEditor(page);
  const detail = workDetailFixture(work, {
    manualOverrides: { titles: { "ja-jp": "Example Japanese" } },
    titleChoices: {
      "": { title: "Example original", language: "", source: "original", code: work.primaryCode, description: "" },
      "ja-jp": {
        title: "Example Japanese",
        language: "ja-jp",
        source: "manual",
        code: work.primaryCode,
        description: "",
      },
      "zh-cn": { title: "Example Chinese", language: "zh-cn", source: "dlsite", code: "RJ00000001", description: "" },
    },
  });
  await page.route("**/api/works/1?includeMedia=false", (route) => route.fulfill({ json: detail }));
  const writes: unknown[] = [];
  const deletes: string[] = [];
  await page.route("**/api/works/1/manual-overrides", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: detail.manualOverrides });
  });
  await page.route("**/api/works/1/manual-overrides/*", (route) => {
    deletes.push(route.request().url());
    return route.fulfill({ json: { ok: true, deleted: 1 } });
  });
  await page.goto("/metadata");
  const open = () => page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  await open();
  let dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  const allLanguages = dialog.getByRole("textbox", { name: "All languages", exact: true });
  const chinese = dialog.getByRole("textbox", { name: "Simplified Chinese", exact: true });
  const english = dialog.getByRole("textbox", { name: "English", exact: true });
  const japanese = dialog.getByRole("textbox", { name: "Japanese", exact: true });
  await expect(allLanguages).toHaveValue("");
  await expect(allLanguages).toHaveAttribute("placeholder", "Example original");
  await expect(
    dialog.getByRole("group", { name: "All languages" }).getByText("Current source: Original title", { exact: true }),
  ).toBeVisible();
  await expect(chinese).toHaveAttribute("placeholder", "Example Chinese");
  await expect(
    dialog
      .getByRole("group", { name: "Simplified Chinese" })
      .getByText("Current source: DLsite edition RJ00000001", { exact: true }),
  ).toBeVisible();
  await expect(japanese).toHaveValue("Example Japanese");
  await chinese.fill("【简体中文版】Example authored Chinese");
  await english.fill("Example authored English");
  await expect(dialog.getByText("Unsaved: Title", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([
    { titles: { "zh-cn": "【简体中文版】Example authored Chinese", "en-us": "Example authored English" } },
  ]);

  await open();
  dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await chinese.fill("Example Chinese draft to keep");
  await dialog.getByRole("button", { name: "Revert the Japanese title", exact: true }).click();
  await expect(japanese).toHaveValue("");
  await expect(dialog.getByRole("group", { name: "Japanese" }).getByText("Reverts on save")).toBeVisible();
  await dialog.getByRole("tab", { name: /^Credits/ }).click();
  await dialog.getByRole("combobox", { name: "Circle", exact: true }).fill("Example circle draft to keep");
  await dialog.getByRole("tab", { name: /^Title/ }).click();
  await expect(chinese).toHaveValue("Example Chinese draft to keep");
  expect(deletes).toEqual([]);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1]).toMatchObject({
    titles: { "zh-cn": "Example Chinese draft to keep", "ja-jp": null },
    circle: { name: "Example circle draft to keep" },
  });
  expect(deletes).toEqual([]);
});

test("own titles are editable while inherited titles stay hints and clearing matches visible changes", async ({
  page,
}) => {
  await metadataWorkEditor(page);
  const detail = workDetailFixture(work, {
    manualOverrides: { title: "Example universal", titles: { "": "Example universal", "ja-jp": "Example Japanese" } },
    titleChoices: {
      "en-us": {
        title: "Example universal",
        language: "ja-jp",
        source: "manual",
        code: work.primaryCode,
        description: "",
      },
      "ja-jp": {
        title: "Example Japanese",
        language: "ja-jp",
        source: "manual",
        code: work.primaryCode,
        description: "",
      },
    },
  });
  await page.route("**/api/works/1?includeMedia=false", (route) => route.fulfill({ json: detail }));
  const writes: unknown[] = [];
  await page.route("**/api/works/1/manual-overrides", (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: detail.manualOverrides });
  });
  await page.goto("/metadata");
  const open = () => page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  await open();
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  const english = dialog.getByRole("group", { name: "English" });
  const englishTitle = dialog.getByRole("textbox", { name: "English", exact: true });
  const japaneseTitle = dialog.getByRole("textbox", { name: "Japanese", exact: true });
  const save = dialog.getByRole("button", { name: "Save", exact: true });
  await expect(dialog.getByRole("textbox", { name: "All languages", exact: true })).toHaveValue("Example universal");
  await expect(englishTitle).toHaveValue("");
  await expect(englishTitle).toHaveAttribute("placeholder", "Example universal");
  await expect(english.getByText("Current source: Manual title (all languages)", { exact: true })).toBeVisible();
  await expect(english.getByRole("button", { name: /Revert/ })).toHaveCount(0);
  await englishTitle.fill("Example temporary inherited edit");
  await expect(save).toBeEnabled();
  await englishTitle.clear();
  await expect(save).toBeDisabled();
  await expect(dialog.getByText("No unsaved changes", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([]);
  await open();
  await expect(japaneseTitle).toHaveValue("Example Japanese");
  await japaneseTitle.press("End");
  await japaneseTitle.pressSequentially(" revised");
  await expect(japaneseTitle).toHaveValue("Example Japanese revised");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ titles: { "ja-jp": "Example Japanese revised" } }]);
  await open();
  await japaneseTitle.clear();
  await expect(japaneseTitle).toHaveValue("");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1]).toEqual({ titles: { "ja-jp": null } });
});

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
  await dialog.getByRole("tab", { name: "Cover" }).click();
  await dialog.getByRole("button", { name: /cover.png/ }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(cover).toEqual({ locationId: 7 });
  expect(scalarWrites).toEqual([]);
});

test("@desktop override reverts and a metadata link wait for Save", async ({ page }) => {
  await metadataWorkEditor(page);
  const detail = workDetailFixture(work, {
    manualOverrides: {
      circle: { name: "Example manual circle", externalId: "" },
      cover: { assetPath: "covers/1.png", originalPath: `${work.primaryCode}/cover.png`, url: "/synthetic-cover.png" },
    },
  });
  await page.route("**/api/works/1?includeMedia=false", (route) => route.fulfill({ json: detail }));
  const requests: string[] = [];
  const writes: unknown[] = [];
  await page.route("**/api/works/1/manual-overrides", (route) => {
    requests.push("overrides");
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: {} });
  });
  await page.route("**/api/works/1/manual-overrides/cover", (route) => {
    requests.push(`${route.request().method()} cover`);
    return route.fulfill({ json: { ok: true, deleted: 1 } });
  });
  let link: unknown;
  await page.route("**/api/works/1/metadata-link", (route) => {
    requests.push(`${route.request().method()} link`);
    link = route.request().postDataJSON();
    return route.fulfill({
      json: { link: { sourceCode: "RJ00000001", url: "", updatedAt: "" } } satisfies ApiResponse<"setWorkMetadataLink">,
    });
  });
  await page.goto("/metadata");
  await page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByRole("tab", { name: "Credits" }).click();
  await dialog.getByRole("button", { name: "Reset circle", exact: true }).click();
  await expect(dialog.getByRole("group", { name: "Circle" }).getByText("Reverts on save")).toBeVisible();
  await dialog.getByRole("tab", { name: "Cover" }).click();
  await dialog.getByRole("button", { name: "Reset cover", exact: true }).click();
  await dialog.getByRole("tab", { name: "Metadata source" }).click();
  await dialog.getByLabel("DLsite code to use", { exact: true }).fill("rj00000001");
  await dialog.getByRole("button", { name: "Use this code", exact: true }).click();
  await expect(dialog.getByText("Metadata will come from RJ00000001 after you save.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Unsaved: Cover · Credits · Metadata source", { exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(requests).toEqual(["overrides", "DELETE cover", "PUT link"]);
  expect(writes).toEqual([{ circle: null }]);
  expect(link).toEqual({ sourceCode: "RJ00000001" });
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
  await dialog.getByRole("tab", { name: /^Tags/ }).click();
  await dialog.getByRole("button", { name: "Remove Synthetic inherited tag" }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill("Synthetic shared");
  await dialog.getByRole("option", { name: "Synthetic shared tag", exact: true }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill("Synthetic new tag");
  await dialog.getByRole("option", { name: "Create tag: Synthetic new tag", exact: true }).click();
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
  await dialog.getByRole("tab", { name: /^Tags/ }).click();
  await dialog.getByRole("button", { name: "Restore DLsite tags" }).click();
  await expect(dialog.getByRole("button", { name: "Remove Synthetic inherited tag" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1]).toEqual({ overrides: [] });
});

test("tag names are edited by language and saved with the work's tag draft", async ({ page }) => {
  await metadataWorkEditor(page);
  const shared = metadataTagFixture({
    id: 2,
    displayName: "Synthetic shared tag",
    workCount: 3,
    names: [
      { language: "", name: "Synthetic shared tag", source: "manual" },
      { language: "zh-cn", name: "Synthetic provider Chinese", source: "dlsite" },
    ],
  });
  const state: WorkMetadataTags = {
    tags: [{ id: 2, displayName: "Synthetic shared tag", source: "dlsite" }],
    inheritedTags: [{ id: 2, displayName: "Synthetic shared tag", source: "dlsite" }],
    overrides: [],
  };
  const tagWrites: unknown[] = [];
  const nameWrites: unknown[] = [];
  await page.route("**/api/works/1/metadata-tags", (route) => {
    if (route.request().method() === "PUT") tagWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: state });
  });
  await page.route("**/api/metadata/tags?*", (route) =>
    route.fulfill({
      json: { tags: [], total: 0, page: 1, pageSize: 20 } satisfies ApiResponse<"listMetadataTags">,
    }),
  );
  await page.route("**/api/metadata/tags/2", (route) => {
    if (route.request().method() === "PATCH") nameWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: shared });
  });
  await page.goto("/metadata");
  await page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByRole("tab", { name: /^Tags/ }).click();
  await dialog.getByRole("button", { name: "Edit names of Synthetic shared tag by language" }).click();
  const names = dialog.getByRole("region", { name: "Names of Synthetic shared tag" });
  await expect(names.getByText(/Shared by 3 works/)).toBeVisible();
  await expect(names.getByRole("textbox", { name: "All languages", exact: true })).toHaveValue("Synthetic shared tag");
  const chinese = names.getByRole("textbox", { name: "Simplified Chinese", exact: true });
  await expect(chinese).toHaveValue("");
  await expect(chinese).toHaveAttribute("placeholder", "Synthetic provider Chinese");
  await chinese.fill("Synthetic manual Chinese");
  await names.getByRole("button", { name: "Done", exact: true }).click();
  await expect(names).toHaveCount(0);

  await dialog.getByLabel("Add tag", { exact: true }).fill("Synthetic new tag");
  await dialog.getByRole("option", { name: "Create tag: Synthetic new tag", exact: true }).click();
  await dialog.getByRole("button", { name: "Edit names of Synthetic new tag by language" }).click();
  const newNames = dialog.getByRole("region", { name: "Names of Synthetic new tag" });
  await expect(newNames.getByText(/created when you save/)).toBeVisible();
  await newNames.getByRole("textbox", { name: "English", exact: true }).fill(" Synthetic English ");
  await expect(dialog.getByText("Unsaved: Tags", { exact: true })).toBeVisible();
  expect(nameWrites).toEqual([]);
  expect(tagWrites).toEqual([]);

  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(nameWrites).toEqual([{ names: { "zh-cn": "Synthetic manual Chinese" } }]);
  expect(tagWrites).toEqual([
    {
      overrides: [],
      newTags: ["Synthetic new tag"],
      newTagNames: { "Synthetic new tag": { "en-us": "Synthetic English" } },
    },
  ]);
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
  await dialog.getByRole("tab", { name: /^Tags/ }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill("Synthetic draft tag");
  await dialog.getByRole("option", { name: "Create tag: Synthetic draft tag", exact: true }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill(" synthetic DRAFT tag ");
  await expect(dialog.getByRole("option", { name: /Create tag:/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Remove Synthetic draft tag", exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove Synthetic draft tag", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(0);
  await open();
  dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByRole("tab", { name: /^Tags/ }).click();
  await expect(dialog.getByText("No metadata tags.", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove Synthetic draft tag", exact: true })).toHaveCount(0);
  await dialog.getByLabel("Add tag", { exact: true }).fill(" synthetic ALTERNATE name ");
  await expect(dialog.getByRole("option", { name: "Synthetic display tag", exact: true })).toBeVisible();
  await expect(dialog.getByRole("option", { name: /Create tag:/ })).toHaveCount(0);
  await dialog.getByRole("option", { name: "Synthetic display tag", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove Synthetic display tag", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dialog).toHaveCount(0);
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

test("tags are listed by id with the name each language shows", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write"],
  });
  const genre = metadataTagFixture({
    id: 7,
    key: "dlsite-genre:9001",
    displayName: "Synthetic Japanese genre",
    dlsiteGenreId: 9001,
    source: "dlsite",
    names: [
      { language: "ja-jp", name: "Synthetic Japanese genre", source: "dlsite" },
      { language: "en-us", name: "Synthetic authored English", source: "manual" },
      { language: "en-us", name: "Synthetic English genre", source: "dlsite" },
      { language: "zh-cn", name: "Synthetic remote Chinese", source: "provider" },
      { language: "", name: "Synthetic unlabeled", source: "provider" },
    ],
  });
  const custom = metadataTagFixture({ id: 9, displayName: "Synthetic custom tag", names: [] });
  const requests: URLSearchParams[] = [];
  await page.route("**/api/metadata/tags?*", (route) => {
    requests.push(new URL(route.request().url()).searchParams);
    return route.fulfill({
      json: { tags: [genre, custom], total: 2, page: 1, pageSize: 25 } satisfies ApiResponse<"listMetadataTags">,
    });
  });
  await page.goto("/metadata?view=tags");
  const table = page.getByRole("table", { name: "Tags", exact: true });
  await expect(table.getByRole("columnheader")).toHaveText([
    "ID",
    "Japanese",
    "Simplified Chinese",
    "Traditional Chinese",
    "English",
    "Korean",
    "Other names",
    "Works",
    "Manage",
  ]);
  // The list is ordered by id, so no language preference changes it.
  expect(requests[0].get("sort")).toBe("id");
  const row = table.getByRole("row").filter({ hasText: "DLsite 9001" });
  await expect(row.getByRole("rowheader")).toHaveText("7 DLsite 9001");
  await expect(row.getByRole("cell")).toHaveText([
    "Synthetic Japanese genre",
    "Synthetic remote Chinese",
    "—",
    "Synthetic authored English",
    "—",
    /^Synthetic English genre · English\s*Synthetic unlabeled$/,
    "1",
    "Manage",
  ]);
  // A stored name without name records is still listed.
  const customRow = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: "9", exact: true }) });
  await expect(customRow.getByRole("listitem")).toHaveText(["Synthetic custom tag"]);
  // The wide table scrolls inside its own box; the page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
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
  await dialog.getByRole("tab", { name: /^Tags/ }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill("Example hidden tag");
  await expect(dialog.getByRole("option", { name: "Example hidden tag · Hidden", exact: true })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(dialog.getByRole("alert")).toContainText("Unhide it in Metadata");
  await expect(dialog.getByRole("option", { name: "Create tag: Example hidden tag", exact: true })).toHaveCount(0);
});

test("admin merge targets mark hidden tags and explain the resulting visibility", async ({ page }) => {
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    authenticated: true,
    permissions: ["library:read", "library:write"],
  });
  const entry = metadataTagFixture();
  const target = metadataTagFixture({
    id: 2,
    displayName: "Example hidden target",
    hidden: true,
    resolvedHidden: true,
  });
  await page.route("**/api/metadata/tags?*", (route) =>
    route.fulfill({
      json: { tags: [entry, target], total: 2, page: 1, pageSize: 25 } satisfies ApiResponse<"listMetadataTags">,
    }),
  );
  let merge: unknown;
  await page.route("**/api/metadata/tags/1/merge", (route) => {
    merge = route.request().postDataJSON();
    return route.fulfill({ json: { ...entry, mergedIntoTagId: 2, resolvedHidden: true } });
  });
  await page.goto("/metadata?view=tags");
  await page.getByRole("button", { name: "Manage Synthetic tag", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Merge target", { exact: true }).fill("Example hidden");
  await dialog.getByRole("button", { name: "Example hidden target · Hidden", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "The target is hidden. After merging, this tag will be hidden on all works.",
  );
  await dialog.getByRole("button", { name: "Merge", exact: true }).click();
  await expect.poll(() => merge).toEqual({ targetTagId: 2 });
});

test("merged tag names complete as the final target and save that identity", async ({ page }) => {
  await metadataWorkEditor(page);
  const target = metadataTagFixture({
    id: 3,
    displayName: "Example final target",
    names: [{ language: "", name: "Example old name", source: "manual" }],
  });
  const writes: unknown[] = [];
  await page.route("**/api/works/1/metadata-tags", (route) => {
    if (route.request().method() === "PUT") {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { tags: [target], inheritedTags: [], overrides: [{ tagId: 3, action: "add" }] } });
    }
    return route.fulfill({ json: { tags: [], inheritedTags: [], overrides: [] } });
  });
  await page.route("**/api/metadata/tags?*", (route) => {
    expect(new URL(route.request().url()).searchParams.get("resolveMerged")).toBe("true");
    return route.fulfill({
      json: { tags: [target], total: 1, page: 1, pageSize: 20 } satisfies ApiResponse<"listMetadataTags">,
    });
  });
  await page.goto("/metadata");
  await page.getByRole("button", { name: `Edit metadata for ${work.primaryCode}` }).click();
  const dialog = page.getByRole("dialog", { name: "Edit metadata", exact: true });
  await dialog.getByRole("tab", { name: /^Tags/ }).click();
  await dialog.getByLabel("Add tag", { exact: true }).fill("Example old name");
  await expect(dialog.getByRole("option", { name: "Create tag: Example old name", exact: true })).toHaveCount(0);
  await dialog.getByRole("option", { name: "Example final target", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Remove Example final target", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toEqual([{ overrides: [{ tagId: 3, action: "add" }] }]);
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
    code: "RG00000001",
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
  // Rows are keyed by DLsite maker id, not by the name anyone authored.
  const table = page.getByRole("table", { name: "Circles", exact: true });
  await expect(table.getByRole("rowheader")).toHaveText(["RG00000000", "RG00000001"]);
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
