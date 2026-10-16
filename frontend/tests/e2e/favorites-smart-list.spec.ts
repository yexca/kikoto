import { expect, test, type Page } from "@playwright/test";

import type { FavoriteList, FavoriteWorksPage, SmartListRule, Work } from "../../src/lib/api";
import { syntheticWorkCode } from "../../src/test-support/workCode";
import {
  type ApiErrorBody,
  type ApiResponse,
  authenticatedStateFixture,
  circleSummaryPageFixture,
  favoriteListFixture,
  runtimeSettingsFixture,
  voiceSummaryPageFixture,
  workFixture,
  worksPageFixture,
} from "./fixtures/api";

const works: Work[] = Array.from({ length: 3 }, (_, index) =>
  workFixture({
    id: index + 1,
    primaryCode: syntheticWorkCode("RJ", index),
    title: `Smart work ${index + 1}`,
    tags: ["Example Tag A"],
    favorite: false,
  }),
);

async function mockSmartLists(page: Page) {
  const state = {
    lists: [favoriteListFixture()] as FavoriteList[],
    created: null as { kind?: string; rule?: SmartListRule } | null,
    seen: false,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/api/auth/me") {
      await route.fulfill({
        json: authenticatedStateFixture({
          permissions: ["library:read", "playback:use", "favorites:write", "tags:write"],
          devMode: true,
        }),
      });
      return;
    }
    if (path === "/api/favorite-lists" && request.method() === "GET") {
      await route.fulfill({ json: state.lists });
      return;
    }
    if (path === "/api/favorite-lists" && request.method() === "POST") {
      const body = request.postDataJSON() as { name: string; kind?: "user" | "smart"; rule?: SmartListRule };
      state.created = body;
      const list = favoriteListFixture({
        id: 7,
        name: body.name,
        kind: body.kind ?? "user",
        sortOrder: 0,
        rule: {
          includeMatch: "all",
          include: [{ kind: "metadata", id: 101, name: "Example Tag A", state: "active" }],
          exclude: [],
        },
      });
      state.lists = [...state.lists, list];
      await route.fulfill({ status: 201, json: list });
      return;
    }
    if (path === "/api/favorite-lists/rule-tags") {
      await route.fulfill({ json: { tags: [{ id: 101, name: "Example Tag A", workCount: 3 }], total: 1 } });
      return;
    }
    if (path === "/api/favorite-lists/rule-preview") {
      await route.fulfill({ json: { total: 3, works: [] } });
      return;
    }
    if (path === "/api/favorite-lists/7/seen" && request.method() === "POST") {
      state.seen = true;
      await route.fulfill({ json: { listId: 7, newCount: 0 } });
      return;
    }
    if (path === "/api/favorite-works") {
      const smart = url.searchParams.get("listId") === "7";
      const newIDs = smart && !state.seen ? [3] : [];
      await route.fulfill({
        json: {
          ...worksPageFixture(smart ? works : [], { total: smart ? works.length : 0 }),
          shelfTotal: 0,
          listCounts: { "1": 0, "7": works.length },
          statusCounts: smart ? { none: works.length } : {},
          newCounts: newIDs.length > 0 ? { "7": newIDs.length } : {},
          newWorkIds: newIDs,
        } satisfies FavoriteWorksPage,
      });
      return;
    }
    if (path === "/api/tags") {
      await route.fulfill({ json: { scope: "work", tags: [] } satisfies ApiResponse<"listUserTags"> });
      return;
    }
    if (path === "/api/circles") {
      await route.fulfill({ json: circleSummaryPageFixture([], { pageSize: 100 }) });
      return;
    }
    if (path === "/api/voices") {
      await route.fulfill({ json: voiceSummaryPageFixture([], { pageSize: 100 }) });
      return;
    }
    if (path === "/api/library-sources") {
      await route.fulfill({ json: [] });
      return;
    }
    if (path === "/api/runtime-settings") {
      await route.fulfill({ json: runtimeSettingsFixture({ anonymousAccessEnabled: false }) });
      return;
    }
    await route.fulfill({ status: 404, json: { error: `Not mocked: ${path}` } satisfies ApiErrorBody });
  });
  return state;
}

test("@desktop a smart list is created from tags and reports its new works until they are seen", async ({ page }) => {
  const state = await mockSmartLists(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/favorites");

  await page.getByRole("navigation", { name: "Favorite shelves" }).getByRole("button", { name: "Add list" }).click();
  const editor = page.getByRole("form", { name: "Add list" });
  await editor.getByRole("radio", { name: "Smart list" }).click();
  await expect(editor.getByRole("button", { name: "Add list" })).toBeDisabled();
  await editor.getByRole("textbox").first().fill("Example smart list");
  // Suggestions open as a dropdown over the editor, so the fields below stay in place.
  const excludeField = editor.getByRole("combobox", { name: "Exclude tags: Search tags" });
  const excludeTop = (await excludeField.boundingBox())?.y;
  await editor.getByRole("combobox", { name: "Include tags: Search tags" }).fill("example");
  const suggestion = page
    .getByRole("listbox", { name: "Include tags: Search tags" })
    .getByRole("option", { name: /Example Tag A/ });
  await expect(suggestion).toBeVisible();
  expect((await excludeField.boundingBox())?.y).toBe(excludeTop);
  await suggestion.click();
  await expect(editor.getByRole("status")).toHaveText("3 works match this rule");
  await editor.getByRole("button", { name: "Add list" }).click();

  expect(state.created).toMatchObject({
    kind: "smart",
    rule: { includeMatch: "all", include: [{ kind: "metadata", id: 101 }], exclude: [] },
  });
  await page.getByRole("button", { name: "Done" }).click();

  const rule = page.getByRole("region", { name: "Smart list rule" });
  await expect(rule).toContainText("Example Tag A");
  await expect(rule.getByText("1 new work")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Favorite shelves" }).getByRole("button", { name: /Example smart list/ }),
  ).toHaveAccessibleName(/1 new work/);

  await rule.getByRole("button", { name: "Mark all as seen" }).click();
  await expect.poll(() => state.seen).toBe(true);
  await expect(rule.getByText("1 new work")).toBeHidden();
});
