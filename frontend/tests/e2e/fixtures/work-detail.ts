import type { Page } from "@playwright/test";

/** Below this width the work detail splits into Info and Directory tabs. */
const compactDetailMaxWidth = 767;

export function isCompactWorkDetail(page: Page) {
  return (page.viewportSize()?.width ?? Infinity) <= compactDetailMaxWidth;
}

/** Shows a compact work detail tab; a wider detail shows both at once. */
export async function showWorkDetailTab(page: Page, tab: "Info" | "Directory") {
  if (!isCompactWorkDetail(page)) return;
  await page.getByRole("button", { name: tab, exact: true }).click();
}

/**
 * Opens the Directory's sources: a compact detail's source menu, which lists
 * each source as a radio titled `<label>: <status>`, or a wider detail's
 * source tab row. Close the menu with `closeDetailSources`.
 */
export async function openDetailSources(page: Page) {
  if (!isCompactWorkDetail(page)) return page.getByTestId("directory-panel");
  await page.getByRole("button", { name: /^Directory source: / }).click();
  const menu = page.getByRole("dialog", { name: "Directory source", exact: true });
  await menu.waitFor();
  return menu;
}

export async function closeDetailSources(page: Page) {
  if (!isCompactWorkDetail(page)) return;
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Directory source", exact: true }).waitFor({ state: "hidden" });
}

/** Shows the Directory from the source titled `<label>: <status>`. */
export async function selectDetailSource(page: Page, title: string) {
  const sources = await openDetailSources(page);
  await sources.locator(`button[title="${title}"]`).click();
}

/**
 * Opens the directory edition list: a compact detail's source menu opens it
 * from its first row, and a wider detail's edition chip opens it directly.
 */
export async function openDirectoryEditions(page: Page) {
  if (isCompactWorkDetail(page)) {
    await page.getByRole("button", { name: /^Directory source: / }).click();
    await page.getByRole("button", { name: /^Directory edition/ }).click();
  } else {
    await page.getByRole("button", { name: "Directory edition", exact: true }).click();
  }
  return page.getByRole("dialog", { name: "Directory edition", exact: true });
}

export async function openWorkMetadataEditor(page: Page) {
  await page.getByTestId("hero-actions").getByRole("button", { name: "Edit metadata", exact: true }).click();
}

/** The selected source's inline action list, in Source info. */
export function sourceActionList(page: Page) {
  return page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("group", { name: /Source actions for/ });
}

/**
 * Reveals the selected source's actions in Source info, which a compact detail
 * shows in its Info tab. Returns the role the actions carry there.
 */
export async function openSourceActions(page: Page) {
  await showWorkDetailTab(page, "Info");
  return { scope: sourceActionList(page), role: "button" as const };
}

export async function runSourceAction(page: Page, name: string | RegExp) {
  const { scope, role } = await openSourceActions(page);
  await scope.getByRole(role, { name, exact: typeof name === "string" }).click();
}
