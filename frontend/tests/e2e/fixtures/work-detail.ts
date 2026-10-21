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

export async function openWorkMetadataEditor(page: Page) {
  await showWorkDetailTab(page, "Info");
  await page.getByRole("button", { name: "Edit metadata", exact: true }).click();
}

/** The selected source's inline action list, in Source info. */
export function sourceActionList(page: Page) {
  return page
    .getByRole("complementary", { name: "Source info", exact: true })
    .getByRole("group", { name: /Source actions for/ });
}

/**
 * Reveals the selected source's actions: the Source menu beside the Hero
 * actions, or the inline list in the compact Info tab. Returns the role the
 * actions carry there.
 */
export async function openSourceActions(page: Page) {
  if (isCompactWorkDetail(page)) {
    await showWorkDetailTab(page, "Info");
    return { scope: sourceActionList(page), role: "button" as const };
  }
  await page.getByRole("button", { name: /Source actions for/ }).click();
  return { scope: page, role: "menuitem" as const };
}

export async function runSourceAction(page: Page, name: string | RegExp) {
  const { scope, role } = await openSourceActions(page);
  await scope.getByRole(role, { name, exact: typeof name === "string" }).click();
}
