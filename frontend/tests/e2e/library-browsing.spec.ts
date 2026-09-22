import { expect, test } from "@playwright/test";
import { work, MockWork, mockApplication, mediaFixture } from "./fixtures/player-library";

test("column preferences change the rendered collection and remain independent across viewport sizes", async ({
  page,
}) => {
  await mockApplication(page, undefined, false, 6);
  await page.goto("/");
  const cards = page.getByTestId("work-card");
  await expect(cards).toHaveCount(6);
  const expectColumns = async (columns: number) => {
    // The user-selected column count must affect the actual card layout,
    // without clipping the mobile viewport (docs/development/design.md responsive contract).
    await expect(async () => {
      const boxes = await cards.evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, right, width } = element.getBoundingClientRect();
          return { x, y, right, width };
        }),
      );
      const firstRow = boxes.filter((box) => Math.abs(box.y - boxes[0].y) < 1);
      expect(firstRow).toHaveLength(columns);
      for (const [index, box] of firstRow.entries()) {
        expect(box.width).toBeGreaterThan(0);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width);
        if (index > 0) expect(box.x).toBeGreaterThanOrEqual(firstRow[index - 1].right);
      }
    }).toPass();
  };
  await page.getByRole("button", { name: /^Columns:/ }).click();
  await page.getByRole("button", { name: "2 columns", exact: true }).click();
  await expectColumns(2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: /^Columns:/ }).click();
  await page.getByRole("button", { name: "3 columns", exact: true }).click();
  await expectColumns(3);
  await page.reload();
  await expectColumns(3);
  await page.setViewportSize({ width: 412, height: 915 });
  await expectColumns(2);
});

test("new detail navigation starts at the top, preserves user scroll while media loads, and returning restores the library position", async ({
  page,
}) => {
  await mockApplication(page, undefined, false, 24, 350);
  await page.goto("/");
  const target = page.getByText("Mobile work 18", { exact: true });
  await target.scrollIntoViewIfNeeded();
  const savedScroll = await page.evaluate(() => window.scrollY);
  expect(savedScroll).toBeGreaterThan(500);
  await target.click();
  await expect(page).toHaveURL(/\/RJ00000017/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(10);
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.waitForTimeout(650);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(50);

  const firstListFrame = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const startedAt = performance.now();
        let firstListY: number | null = null;
        const sample = () => {
          if (window.location.pathname === "/" && firstListY === null) firstListY = window.scrollY;
          if (firstListY !== null || performance.now() - startedAt >= 1500) {
            resolve(firstListY ?? window.scrollY);
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
  await page.getByRole("main").getByRole("button", { name: "Library", exact: true }).click();
  expect(await firstListFrame).toBeGreaterThan(savedScroll - 80);
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/(?:\?.*)?$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(savedScroll - 80);
});

test("mobile tabs restore the current Library detail after visiting a voice actor", async ({ page }) => {
  const voicedWork: MockWork = {
    ...work,
    voiceActors: ["Example Voice"],
    voiceCredits: [{ personId: 7, displayName: "Example Voice" }],
  };
  const detailMedia = Array.from({ length: 18 }, (_, index) =>
    mediaFixture(
      index + 1,
      `voice-track-${index + 1}.mp3`,
      `${voicedWork.primaryCode}/voice-track-${index + 1}.mp3`,
      "audio",
    ),
  );
  await mockApplication(page, undefined, false, 1, 0, detailMedia, undefined, { work: voicedWork });
  await page.goto("/");

  await page.getByText(voicedWork.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${voicedWork.primaryCode}`));
  await page.getByRole("button", { name: "Example Voice", exact: true }).first().click();
  await expect(page).toHaveURL(/\/voices\/7$/);
  await expect(page.getByRole("heading", { name: "Example Voice", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Library", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/${voicedWork.primaryCode}`));
  await expect(page.getByText(voicedWork.title, { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("directory-file-row")).toHaveCount(detailMedia.length);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  const savedDetailScroll = await page.evaluate(() => window.scrollY);

  await page.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await expect(page).toHaveURL(/\/voices\/7$/);
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${voicedWork.primaryCode}`));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(savedDetailScroll - 80);

  await page.getByRole("main").getByRole("button", { name: "Library", exact: true }).click();
  await expect(page).toHaveURL(/^http:\/\/[^/]+\/(?:\?.*)?$/);
  await expect(page.getByText(voicedWork.title, { exact: true }).first()).toBeVisible();
});

test("mobile library pagination returns to the page top after detail return", async ({ page }) => {
  await mockApplication(page, undefined, false, 48);
  await page.goto("/");
  const target = page.getByText("Mobile work 18", { exact: true });
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await expect(page).toHaveURL(/\/RJ00000017/);
  await page.getByRole("main").getByRole("button", { name: "Library", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  await page.getByRole("button", { name: "Next page" }).last().click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(10);
});

test("tag clicks send a structured Unicode tag search and retain the matching work", async ({ page }) => {
  const requests: string[] = [];
  await mockApplication(page, (url) => requests.push(url.searchParams.get("q") ?? ""));
  await page.goto("/");

  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ロリ", exact: true }).click();
  await expect.poll(() => requests.some((query) => query === "$tag:ロリ$")).toBe(true);
  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();
});

test("toolbar popovers stay anchored below their trigger and inside the mobile viewport", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Sort: Recommended" });
  await trigger.click();
  const popover = page.locator(".fixed.z-50").filter({ hasText: "Recently added" });
  await expect(popover).toBeVisible();
  const [triggerBox, popoverBox, viewport] = await Promise.all([
    trigger.boundingBox(),
    popover.boundingBox(),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  expect(triggerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height - 1);
  expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport.height);

  const selectedSort = page.getByRole("button", { name: "Recommended", exact: true });
  await expect(selectedSort).toHaveClass(/bg-primary\/10/);
  await expect(selectedSort.locator("xpath=parent::div").getByRole("button")).toHaveText([
    "Recommended",
    "Recently added",
    "Release date",
    "Random",
    "Rating",
    "Code",
    "Sales",
    "Title",
  ]);
  await expect(selectedSort.locator("svg")).toHaveCount(0);
  expect((await selectedSort.locator("xpath=parent::div").boundingBox())!.width).toBeLessThanOrEqual(200);
});

test("recommended sorting refreshes its stable seed", async ({ page }) => {
  const requestedSeeds: string[] = [];
  await mockApplication(page, (url) => requestedSeeds.push(url.searchParams.get("seed") ?? ""), false, 8);
  await page.goto("/");

  const refresh = page.getByRole("button", { name: "Refresh recommendations", exact: true });
  await expect(refresh).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect.poll(() => requestedSeeds.length).toBeGreaterThan(0);
  const initialSeed = requestedSeeds.at(-1);

  await refresh.click();

  await expect.poll(() => requestedSeeds.at(-1)).not.toBe(initialSeed);
  await expect.poll(() => new URL(page.url()).searchParams.get("seed")).toBeNull();
  await expect
    .poll(() => page.evaluate(() => String(window.history.state?.libraryBrowseState?.randomSeed ?? "")))
    .toBe(requestedSeeds.at(-1));
  await expect(page.getByRole("button", { name: "Sort: Recommended", exact: true })).toBeVisible();
  await expect(refresh).toBeEnabled();
});

test("recommendation badge refresh keeps the result grid fixed while the request is pending", async ({ page }) => {
  const requestedURLs: URL[] = [];
  let holdWorksResponse = false;
  let releaseWorksResponse = () => undefined;
  const worksResponseGate = new Promise<void>((resolve) => {
    releaseWorksResponse = resolve;
  });
  await mockApplication(page, (url) => requestedURLs.push(url), false, 8, 0, [], undefined, {
    beforeWorksResponse: async () => {
      if (holdWorksResponse) await worksResponseGate;
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Sort: Recommended" }).click();
  await page.getByRole("button", { name: "Recently added", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sort: Recently added" })).toBeVisible();
  const firstCard = page.getByTestId("work-card").first();
  await expect(firstCard).toBeVisible();
  const initialTop = (await firstCard.boundingBox())!.y;
  const initialRequestCount = requestedURLs.length;
  holdWorksResponse = true;

  await page.getByRole("button", { name: "Show recommendation badges", exact: true }).click();

  await expect.poll(() => requestedURLs.length).toBeGreaterThan(initialRequestCount);
  await expect(page.getByText(/Refreshing (?:remote )?results/i)).toHaveCount(0);
  await expect(firstCard).toBeVisible();
  expect((await firstCard.boundingBox())!.y).toBeCloseTo(initialTop, 0);
  releaseWorksResponse();
  await expect(page.getByRole("button", { name: "Hide recommendation badges", exact: true })).toBeVisible();
});

test("cards keep two complete tag rows and readable Sales and Rate metrics at compact and desktop widths", async ({
  page,
}) => {
  const tags = Array.from({ length: 14 }, (_, index) => `Long metadata tag ${index + 1}`);
  const userTags = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    name: `Personal tag ${index + 1}`,
    color: "",
  }));
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { work: { ...work, tags, userTags } });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.goto("/?mobileColumns=2&desktopColumns=5");

  await expect(page.getByText("R18", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Personal tag 10", exact: true })).toBeVisible();
  const card = page.getByTestId("work-card").first();
  const tagRows = card.getByTestId("work-card-tags");
  const rate = card.getByRole("img", { name: "Rate 4.50 out of 5 from 240 ratings", exact: true });
  await expect(card.getByText("Sales", { exact: true })).toBeVisible();
  await expect(card.getByText("DL", { exact: true })).toHaveCount(0);
  await expect(card.getByText("4.50", { exact: true })).toBeVisible();
  await expect(rate).toBeVisible();
  await expect(rate.locator("[aria-hidden=true] > span")).toHaveCount(5);

  const assertTagRowsAreComplete = async (minimumCardWidth: number, maximumCardWidth: number) => {
    await expect
      .poll(async () =>
        tagRows.evaluate((element) => {
          const row = element.firstElementChild;
          return new Set(Array.from(row?.children ?? []).map((child) => Math.round(child.getBoundingClientRect().top)))
            .size;
        }),
      )
      .toBe(2);
    const layout = await tagRows.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const row = element.firstElementChild;
      const badges = Array.from(row?.children ?? []).map((child) => child.getBoundingClientRect());
      const cardElement = element.closest<HTMLElement>('[data-testid="work-card"]');
      return {
        cardWidth: cardElement?.getBoundingClientRect().width ?? 0,
        cardFitsHorizontally: cardElement ? cardElement.scrollWidth <= cardElement.clientWidth + 1 : false,
        containerHeight: bounds.height,
        containerBottom: bounds.bottom,
        firstTop: Math.min(...badges.map((badge) => badge.top)),
        lastBottom: Math.max(...badges.map((badge) => badge.bottom)),
      };
    });
    expect(layout.cardWidth).toBeGreaterThanOrEqual(minimumCardWidth);
    expect(layout.cardWidth).toBeLessThanOrEqual(maximumCardWidth);
    expect(layout.cardFitsHorizontally).toBe(true);
    expect(layout.lastBottom).toBeLessThanOrEqual(layout.containerBottom + 0.75);
    expect(layout.containerHeight).toBeGreaterThanOrEqual(layout.lastBottom - layout.firstTop - 0.75);
  };
  await assertTagRowsAreComplete(160, 205);

  let overflow = page.locator('button[aria-label^="Show "][aria-label$=" more tags"]');
  await expect(overflow).toBeVisible();
  await overflow.click();
  await expect(page.getByRole("button", { name: "Long metadata tag 14", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1600, height: 900 });
  await assertTagRowsAreComplete(210, 280);

  overflow = page.locator('button[aria-label^="Show "][aria-label$=" more tags"]');
  await expect(overflow).toBeVisible();
  await overflow.click();
  await expect(page.getByRole("button", { name: "Long metadata tag 14", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Personal tag 10", exact: true })).toBeVisible();
});

test("recently played opens from a toolbar popover and returns to the work", async ({ page }) => {
  const recentWorks = [
    {
      ...work,
      id: 21,
      primaryCode: "RJ00000060",
      title: "Short title",
      progress: {
        ...work.progress,
        title: "Track one",
        positionSeconds: 42,
        durationSeconds: 120,
        lastPlayedAt: "2026-01-02T00:00:00Z",
      },
    },
    {
      ...work,
      id: 22,
      primaryCode: "RJ00000061",
      title: "A deliberately long title that occupies both reserved title lines",
      circle: "A circle name that is deliberately too long for the compact card",
      progress: {
        ...work.progress,
        title: "Track two",
        positionSeconds: 84,
        durationSeconds: 180,
        lastPlayedAt: "2026-01-01T00:00:00Z",
      },
    },
  ];
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { recentWorks });

  await page.goto("/library");
  await expect(page.getByRole("button", { name: "Recently played", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(page.getByRole("button", { name: "Open Short title" })).toHaveCount(0);

  await page.getByRole("button", { name: "Recently played", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Recently played" });
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("button", { name: "Open Short title" })).toBeVisible();
  await expect(
    popover.getByRole("button", { name: "Open A deliberately long title that occupies both reserved title lines" }),
  ).toBeVisible();
  await expect(popover.getByText("Track one · 0:42 / 2:00", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  await page.getByRole("button", { name: "Recently played", exact: true }).click();
  await popover.getByRole("button", { name: "Open Short title" }).click();
  await expect(popover).toBeHidden();
  await expect(page).toHaveURL(/\/RJ00000060(?:\?|$)/);
});

test("favorite list popovers use measured mobile placement and stay inside the usable viewport", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Add to list" });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const popover = page.locator(".fixed.z-50").filter({ hasText: "Lists" });
  await expect(popover).toBeVisible();
  const [triggerBox, popoverBox, viewport] = await Promise.all([
    trigger.boundingBox(),
    popover.boundingBox(),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  expect(triggerBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox!.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.x + popoverBox!.width).toBeLessThanOrEqual(viewport.width);
  expect(popoverBox!.y).toBeGreaterThanOrEqual(0);
  expect(popoverBox!.y + popoverBox!.height).toBeLessThanOrEqual(viewport.height - 150);
});

test("library search follows the user across scopes and survives navigation", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Search library" }).click();
  const search = page.getByPlaceholder("Search title, code, circle, tag, or creator");
  await search.fill("local term");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("local term");
  await page.getByRole("button", { name: "Hide library search" }).click();
  await expect(search).toBeHidden();
  await page.getByRole("button", { name: "Search library" }).click();
  await expect(search).toBeVisible();
  await expect(search).toHaveValue("local term");
  await page.getByRole("button", { name: "Tracked", exact: true }).click();
  await expect(search).toHaveValue("local term");
  await search.fill("tracked term");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("tracked term");
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await expect(search).toHaveValue("tracked term");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("tracked term");
  await page.reload();
  await expect(search).toHaveValue("tracked term");
});

test("library search conditions use accessible select menus", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await mockApplication(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Search library" }).click();
  await page.getByRole("button", { name: "Add search condition" }).click();

  const clauseType = page.getByRole("combobox", { name: "Search clause type" });
  await expect(clauseType).toHaveText("Text");
  const searchBox = page.getByPlaceholder("Search title, code, circle, tag, or creator");
  const toolbar = page.locator("section[data-toast-avoid]").filter({ has: searchBox });
  await expect(toolbar.getByRole("button", { name: /Items per page:/ })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Sort: Recommended" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: /^Columns:/ })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Filters" })).toBeVisible();
  const actionButtons = [
    toolbar.getByRole("button", { name: /Items per page:/ }),
    toolbar.getByRole("button", { name: /^Columns:/ }),
    toolbar.getByRole("button", { name: /^Sort:/ }),
    toolbar.getByRole("button", { name: "Filters" }),
  ];
  const actionBoxes = await Promise.all(actionButtons.map((button) => button.boundingBox()));
  const searchBoxBounds = await searchBox.boundingBox();
  expect(actionBoxes.every((box) => box !== null)).toBe(true);
  expect(searchBoxBounds).not.toBeNull();
  expect(searchBoxBounds!.y).toBeGreaterThanOrEqual(Math.max(...actionBoxes.map((box) => box!.y + box!.height)));

  await toolbar.getByRole("button", { name: "Hide library search" }).click();
  await expect(clauseType).toHaveCount(0);
  await expect(searchBox).toBeHidden();
  await expect(toolbar.getByRole("button", { name: /^Columns:/ })).toBeVisible();
  await toolbar.getByRole("button", { name: "Search library" }).click();
  await page.getByRole("button", { name: "Add search condition" }).click();
  await expect(clauseType).toHaveText("Text");

  const clauseTypeBox = await clauseType.boundingBox();
  const clauseValueBox = await page.getByPlaceholder("Value").boundingBox();
  expect(clauseTypeBox).not.toBeNull();
  expect(clauseValueBox).not.toBeNull();
  expect(Math.abs(clauseTypeBox!.y - clauseValueBox!.y)).toBeLessThan(1);
  expect(Math.abs(clauseTypeBox!.height - clauseValueBox!.height)).toBeLessThan(1);
  const mobileCancelBox = await page.getByRole("button", { name: "Cancel", exact: true }).boundingBox();
  expect(mobileCancelBox).not.toBeNull();
  expect(mobileCancelBox!.x + mobileCancelBox!.width).toBeGreaterThanOrEqual(page.viewportSize()!.width - 32);
  await clauseType.click();
  await page.getByRole("listbox").getByRole("option", { name: "On shelf", exact: true }).click();

  const shelfMembership = page.getByRole("combobox", { name: "Shelf membership" });
  await expect(shelfMembership).toHaveText("Included");
  await shelfMembership.click();
  const membershipOptions = page.getByRole("listbox");
  await expect(membershipOptions.getByRole("option", { name: "Included", exact: true })).toBeVisible();
  await expect(membershipOptions.getByRole("option", { name: "Not included", exact: true })).toBeVisible();
  await membershipOptions.getByRole("option", { name: "Not included", exact: true }).click();
  await expect(shelfMembership).toHaveText("Not included");

  await page.setViewportSize({ width: 700, height: page.viewportSize()!.height });
  const wideClauseTypeBox = await clauseType.boundingBox();
  const wideClauseValueBox = await shelfMembership.boundingBox();
  const wideCancelBox = await page.getByRole("button", { name: "Cancel", exact: true }).boundingBox();
  expect(wideClauseTypeBox).not.toBeNull();
  expect(wideClauseValueBox).not.toBeNull();
  expect(wideCancelBox).not.toBeNull();
  expect(Math.abs(wideClauseTypeBox!.y - wideCancelBox!.y)).toBeLessThan(3);
  expect(Math.abs(wideClauseValueBox!.y - wideCancelBox!.y)).toBeLessThan(3);

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(clauseType).toHaveCount(0);
});

test("anonymous quick marks open the sign-in flow from mobile controls", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Mark: Unmarked" }).click();
  await expect(page.getByRole("button", { name: "Unmarked", exact: true })).toHaveClass(/bg-primary\/10/);
  await page.getByRole("button", { name: "Want", exact: true }).click();
  await expect(page.getByText("Sign in is required.", { exact: true })).toBeVisible();
  await page.locator('[aria-live="polite"]').getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();
});

test("@desktop anonymous quick marks open the sign-in flow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Mark: Unmarked" }).click();
  await page.getByRole("button", { name: "Want", exact: true }).click();
  await expect(page.getByText("Sign in is required.", { exact: true })).toBeVisible();
  await page.locator('[aria-live="polite"]').getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();
});

test("library request failures are not presented as an empty collection", async ({ page }) => {
  await mockApplication(page);
  await page.route("**/api/works?**", (route) =>
    route.fulfill({ status: 500, json: { error: "database temporarily unavailable" } }),
  );
  await page.goto("/");

  await expect(page.getByText("Library could not be loaded.")).toBeVisible();
  await expect(page.getByText("database temporarily unavailable")).toBeVisible();
  await expect(page.getByText("No local works match this view.")).toBeHidden();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
