import { expect, type Page } from "@playwright/test";

/** The Library's View entry at the end of the toolbar. */
export function libraryViewButton(page: Page) {
  return page.getByRole("button", { name: "View", exact: true });
}

/** The View panel: a popover on wide layouts and a sheet on phones. */
export function libraryViewPanel(page: Page) {
  return page.getByRole("dialog", { name: "View", exact: true });
}

/** Opens the View panel when it is closed and returns it. */
export async function openLibraryView(page: Page) {
  const panel = libraryViewPanel(page);
  if (!(await panel.isVisible())) await libraryViewButton(page).click();
  await expect(panel).toBeVisible();
  return panel;
}

export async function closeLibraryView(page: Page) {
  await page.keyboard.press("Escape");
  await expect(libraryViewPanel(page)).toBeHidden();
}

/** The toolbar's sort button, which names the current order. */
export function librarySortButton(page: Page) {
  return page.getByRole("button", { name: /^Sort: / });
}

/** Opens the toolbar's order menu and returns it. */
export async function openLibrarySort(page: Page) {
  const popover = page.getByRole("menu", { name: "Sort", exact: true });
  if (!(await popover.isVisible())) await librarySortButton(page).click();
  await expect(popover).toBeVisible();
  return popover;
}

/** Chooses an order from the toolbar's order menu, which closes on the choice. */
export async function chooseLibrarySort(page: Page, name: string) {
  const popover = await openLibrarySort(page);
  await popover.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(popover).toBeHidden();
}

/** Turns the recommendation scores of an order that does not score every work on or off, then closes the panel. */
export async function setRecommendationScores(page: Page, enabled: boolean) {
  const panel = await openLibraryView(page);
  const scores = panel.getByRole("switch", { name: "Recommendation scores", exact: true });
  if ((await scores.getAttribute("aria-checked")) !== String(enabled)) await scores.click();
  await expect(scores).toHaveAttribute("aria-checked", String(enabled));
  await closeLibraryView(page);
}

function startWithWorkCards(page: Page, mode: "full" | "simple") {
  return page.addInitScript((cardMode) => {
    const key = "kikoto:work-collection-layout";
    if (window.localStorage.getItem(key) === null) {
      window.localStorage.setItem(key, JSON.stringify({ mobileCardMode: cardMode, desktopCardMode: cardMode }));
    }
  }, mode);
}

/**
 * Starts the page with full work cards, which keep their facts and action row
 * on show, so a test about a card fact or action does not depend on the
 * default card mode. A choice made during the test survives a reload.
 */
export async function showFullWorkCards(page: Page) {
  await startWithWorkCards(page, "full");
}

/**
 * Starts the page with simple work cards, which bring their facts and action
 * row up on hover, keyboard focus, or their touch toggle. A choice made during
 * the test survives a reload.
 */
export async function showSimpleWorkCards(page: Page) {
  await startWithWorkCards(page, "simple");
}
