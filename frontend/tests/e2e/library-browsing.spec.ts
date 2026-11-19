import { expect, test } from "@playwright/test";
import { worksPageFixture, type ApiErrorBody } from "./fixtures/api";
import { work, type MockWork, mockApplication, mediaFixture, selectLibrarySource } from "./fixtures/player-library";
import {
  chooseLibrarySort,
  closeLibraryView,
  librarySortButton,
  libraryViewButton,
  openLibrarySort,
  openLibraryView,
  setRecommendationScores,
  showFullWorkCards,
  showSimpleWorkCards,
} from "./fixtures/library-view";

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
  await (await openLibraryView(page)).getByRole("radio", { name: "2 columns", exact: true }).click();
  await closeLibraryView(page);
  await expectColumns(2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await (await openLibraryView(page)).getByRole("radio", { name: "3 columns", exact: true }).click();
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
    voiceCredits: [{ personId: 7, routeKey: "00000001", displayName: "Example Voice" }],
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
  await expect(page).toHaveURL(/\/voices\/00000001$/);
  await expect(page.getByRole("heading", { name: "Example Voice", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Library", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/${voicedWork.primaryCode}`));
  await expect(page.getByText(voicedWork.title, { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("directory-file-row")).toHaveCount(detailMedia.length);
  await page.evaluate(() => window.scrollTo(0, 500));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(200);
  const savedDetailScroll = await page.evaluate(() => window.scrollY);

  await page.getByRole("button", { name: "Voice Actors", exact: true }).click();
  await expect(page).toHaveURL(/\/voices\/00000001$/);
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

test("library keeps its page across a reload", async ({ page }) => {
  const requestedPages: string[] = [];
  await mockApplication(
    page,
    (url) => {
      if (url.searchParams.get("scope") === "local") requestedPages.push(url.searchParams.get("page") ?? "");
    },
    false,
    48,
  );
  await page.goto("/");
  await expect(page.getByText("Mobile work 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).last().click();
  await expect(page.getByText(/^Page 2 of 2/).first()).toBeVisible();

  requestedPages.length = 0;
  await page.reload();
  await expect(page.getByText(/^Page 2 of 2/).first()).toBeVisible();
  await expect(page.getByText("Mobile work 2", { exact: true })).toBeVisible();
  expect(requestedPages).toEqual(["2"]);
});

test("the pagination ellipsis jumps to a typed page", async ({ page }) => {
  await mockApplication(page);
  await page.route("**/api/works?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("scope") !== "local") return route.fallback();
    return route.fulfill({
      json: worksPageFixture([work], { page: Number(url.searchParams.get("page") ?? 1), total: 480 }),
    });
  });
  await page.goto("/");
  const pages = page.getByRole("navigation", { name: "Pages", exact: true });
  const jump = pages.getByRole("textbox", { name: "Go to page", exact: true });

  await pages.getByRole("button", { name: "Go to page", exact: true }).click();
  await expect(jump).toBeFocused();
  await expect(jump).toHaveValue("1");
  await jump.fill("12");
  await jump.press("Enter");
  await expect(pages.getByRole("button", { name: "Page 12", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(jump).toHaveCount(0);

  // A page past the end lands on the last page.
  await pages.getByRole("button", { name: "Go to page", exact: true }).first().click();
  await jump.fill("999");
  await jump.press("Enter");
  await expect(pages.getByRole("button", { name: "Page 20", exact: true })).toHaveAttribute("aria-current", "page");

  // Escape leaves the page as it is and returns focus to the ellipsis.
  const ellipsis = pages.getByRole("button", { name: "Go to page", exact: true });
  await ellipsis.click();
  await jump.fill("3");
  await jump.press("Escape");
  await expect(ellipsis).toBeFocused();
  await expect(pages.getByRole("button", { name: "Page 20", exact: true })).toHaveAttribute("aria-current", "page");
});

test("tag clicks send a structured Unicode tag search and retain the matching work", async ({ page }) => {
  const requests: string[] = [];
  await mockApplication(page, (url) => requests.push(url.searchParams.get("q") ?? ""));
  await showFullWorkCards(page);
  await page.goto("/");

  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ロリ", exact: true }).click();
  await expect.poll(() => requests.some((query) => query === "$tag:ロリ$")).toBe(true);
  await expect(page.getByText("Tagged mobile work", { exact: true })).toBeVisible();
  // The tag fills the phone search field without raising the keyboard.
  const search = page.getByRole("searchbox", { name: "Search library" });
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();

  // Clearing the tag search reloads the unfiltered library, even though the
  // tag results were loaded without the regular request effect.
  const requestsBeforeClear = requests.length;
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect.poll(() => requests.slice(requestsBeforeClear)).toContain("");
});

test("toolbar popovers stay anchored below their trigger and inside the mobile viewport", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Sort: Recommended" });
  const popover = await openLibrarySort(page);
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

  const selectedSort = popover.getByRole("button", { name: "Recommended", exact: true });
  await expect(selectedSort).toHaveAttribute("aria-pressed", "true");
  await expect(popover.getByRole("list").getByRole("button")).toHaveText([
    "Recommended",
    "Recently added",
    "Release date",
    "Random",
    "Rating",
    "Your rating",
    "Code",
    "Sales",
    "Title",
  ]);
  // The direction sits in the same popover instead of a second toolbar button.
  await expect(popover.getByRole("button", { name: "Descending", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await popover.getByRole("button", { name: "Ascending", exact: true }).click();
  await expect(popover.getByRole("button", { name: "Ascending", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(popover).toBeVisible();
});

test("the phone toolbar puts the order, Mark filter, Recently played, and View on one row inside a 360px screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await mockApplication(page);
  await page.goto("/");
  await expect(page.getByTestId("work-card").first()).toBeVisible();

  const controls = [
    librarySortButton(page),
    page.getByRole("button", { name: "Refresh recommendations", exact: true }),
    page.getByRole("button", { name: "Mark filter", exact: true }),
    page.getByRole("button", { name: "Recently played", exact: true }),
    libraryViewButton(page),
  ];
  const boxes = await Promise.all(controls.map(async (control) => (await control.boundingBox())!));
  const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
  for (const box of boxes) {
    expect(Math.abs(middle(box) - middle(boxes[0]))).toBeLessThan(2);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
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

test("@desktop the wide toolbar sorts from one labeled control", async ({ page }) => {
  const requests: URL[] = [];
  await mockApplication(page, (url) => requests.push(url), false, 8);
  await page.goto("/");

  // The order, the Mark filter, Recently played, and View each rest on the toolbar.
  await expect(page.getByRole("button", { name: "Mark filter", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recently played", exact: true })).toBeVisible();
  await expect(libraryViewButton(page)).toBeVisible();

  // The seeded orders keep a one-click refresh beside the sort button.
  const sort = page.getByRole("button", { name: "Sort: Recommended", exact: true });
  await expect(sort).toHaveText("Recommended");
  await expect(page.getByRole("button", { name: "Refresh recommendations", exact: true })).toBeVisible();

  await sort.click();
  const popover = page.getByRole("dialog", { name: "Sort" });
  await popover.getByRole("button", { name: "Ascending", exact: true }).click();
  await expect.poll(() => requests.at(-1)?.searchParams.get("direction")).toBe("asc");
  await popover.getByRole("button", { name: "Title", exact: true }).click();
  await expect(popover).toBeHidden();

  // The button is the one place the order shows.
  await expect(page.getByRole("button", { name: "Sort: Title", exact: true })).toHaveText("Title");
  await expect(page.getByText("Sort: Title", { exact: true })).toHaveCount(0);
  await expect.poll(() => requests.at(-1)?.searchParams.get("sort")).toBe("title");
  // An order without a seed has nothing to refresh, and its direction lives in the popover.
  await expect(page.getByRole("button", { name: "Refresh recommendations", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ascending", exact: true })).toHaveCount(0);
});

test("@desktop library results that fit one page state their count without a page bar", async ({ page }) => {
  await mockApplication(page, undefined, false, 6);
  await page.goto("/");
  await expect(page.getByTestId("work-card")).toHaveCount(6);
  await expect(page.getByText("6 works", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Next page" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Pages", exact: true })).toHaveCount(0);
});

test("@desktop a simple card rests on its cover, title, and credits and opens its details on hover and keyboard focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page, undefined, false, 6);
  await showSimpleWorkCards(page);
  await page.goto("/");
  const card = page.getByTestId("work-card").first();
  const below = page.getByTestId("work-card").nth(4);
  await expect(card).toHaveAttribute("data-card-layout", "simple");
  await expect(card.getByRole("heading", { name: work.title })).toBeVisible();
  await expect(card.getByRole("button", { name: work.circle, exact: true })).toBeVisible();
  // Nothing at rest acts on the work: the age rating, tags, metrics, and action row wait for the details.
  const quickMark = card.getByRole("button", { name: "Mark: Unmarked" });
  const ageRating = card.getByRole("button", { name: "Age rating: R18", exact: true });
  await expect(quickMark).toHaveCount(0);
  await expect(ageRating).toHaveCount(0);

  // The details lay over the cards below, so the grid keeps its place.
  const [cardBox, belowBox] = [await card.boundingBox(), await below.boundingBox()];
  await card.hover();
  await expect(quickMark).toBeVisible();
  await expect(ageRating).toBeVisible();
  expect(await card.boundingBox()).toEqual(cardBox);
  expect(await below.boundingBox()).toEqual(belowBox);

  // An open menu holds the details while the pointer is on the menu, away from the card.
  await quickMark.click();
  const markMenu = page.locator(".fixed.z-50").filter({ hasText: "Relisten" });
  await markMenu.getByRole("button", { name: "Finished", exact: true }).hover();
  await expect(quickMark).toBeVisible();
  // Pressing elsewhere closes the menu, and with the pointer off the card the details go with it.
  await page.getByRole("heading", { name: "Library", exact: true }).click();
  await expect(markMenu).toHaveCount(0);
  await expect(quickMark).toBeHidden();

  // Keyboard focus opens them as well, and Tab reaches the action row.
  await page.getByPlaceholder(/^Search title/).focus();
  const focusInCard = () => card.evaluate((element) => element.contains(document.activeElement));
  // The toolbar's controls after the search field come first.
  for (let step = 0; step < 12 && !(await focusInCard()); step += 1) await page.keyboard.press("Tab");
  expect(await focusInCard()).toBe(true);
  await expect(quickMark).toBeVisible();
  const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  for (let step = 0; step < 12 && (await focusedLabel()) !== "Mark: Unmarked"; step += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(quickMark).toBeFocused();
});

test("a simple card opens its details in place from its toggle on a touch screen", async ({ page }) => {
  await mockApplication(page, undefined, false, 2);
  await showSimpleWorkCards(page);
  await page.goto("/");
  const card = page.getByTestId("work-card").first();
  const quickMark = card.getByRole("button", { name: "Mark: Unmarked" });
  const ageRating = card.getByRole("button", { name: "Age rating: R18", exact: true });
  const show = card.getByRole("button", { name: "Show details", exact: true });
  await expect(card).toHaveAttribute("data-card-layout", "simple");
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await expect(quickMark).toHaveCount(0);

  await show.click();
  const hide = card.getByRole("button", { name: "Hide details", exact: true });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(quickMark).toBeVisible();
  await expect(ageRating).toBeVisible();
  // The toggle opens the details, not the work.
  expect(new URL(page.url()).pathname).not.toContain(work.primaryCode);

  await hide.click();
  await expect(quickMark).toBeHidden();
  await expect(show).toHaveAttribute("aria-expanded", "false");
});

test("recommendation badge refresh keeps the result grid fixed while the request is pending", async ({ page }) => {
  const requestedURLs: URL[] = [];
  let holdWorksResponse = false;
  let releaseWorksResponse: () => void = () => undefined;
  const worksResponseGate = new Promise<void>((resolve) => {
    releaseWorksResponse = resolve;
  });
  await mockApplication(page, (url) => requestedURLs.push(url), false, 8, 0, [], undefined, {
    beforeWorksResponse: async () => {
      if (holdWorksResponse) await worksResponseGate;
    },
  });
  await page.goto("/");
  await chooseLibrarySort(page, "Recently added");
  await expect(librarySortButton(page)).toHaveAccessibleName("Sort: Recently added");
  const firstCard = page.getByTestId("work-card").first();
  await expect(firstCard).toBeVisible();
  const initialTop = (await firstCard.boundingBox())!.y;
  const initialRequestCount = requestedURLs.length;
  holdWorksResponse = true;

  await setRecommendationScores(page, true);

  await expect.poll(() => requestedURLs.length).toBeGreaterThan(initialRequestCount);
  await expect(page.getByText(/Refreshing (?:remote )?results/i)).toHaveCount(0);
  await expect(firstCard).toBeVisible();
  expect((await firstCard.boundingBox())!.y).toBeCloseTo(initialTop, 0);
  releaseWorksResponse();
  await expect(
    (await openLibraryView(page)).getByRole("switch", { name: "Recommendation scores", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
});

test("narrow cards fold personal and metadata tags into one row while wide cards keep two tag rows and readable metrics", async ({
  page,
}) => {
  const tags = Array.from({ length: 14 }, (_, index) => `Long metadata tag ${index + 1}`);
  const userTags = Array.from({ length: 10 }, (_, index) => ({
    id: index + 1,
    name: `Personal tag ${index + 1}`,
    color: "",
  }));
  const sourcePresence = [
    { type: "local", availability: "available" },
    ...["Remote A", "Remote B"].map((name, index) => ({
      type: "source",
      availability: "available",
      fileSourceId: index + 7,
      fileSourceName: name,
    })),
  ];
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    work: { ...work, tags, userTags, sourcePresence } as typeof work,
  });
  await page.setViewportSize({ width: 412, height: 915 });
  await showFullWorkCards(page);
  await page.goto("/?mobileColumns=2&desktopColumns=5");

  await expect(page.getByText("R18", { exact: true })).toBeVisible();
  const card = page.getByTestId("work-card").first();
  const tagRows = card.getByTestId("work-card-tags");
  const rate = card.getByRole("img", { name: "Rate 4.50 out of 5 from 240 ratings", exact: true });
  await expect(card.getByText("Sales", { exact: true })).toBeVisible();
  await expect(card.getByText("DL", { exact: true })).toHaveCount(0);
  await expect(card.getByText("4.50", { exact: true })).toBeVisible();
  await expect(rate).toBeVisible();
  await expect(rate).toContainText("(240)");

  const assertTagRowsAreComplete = async (rows: number, minimumCardWidth: number, maximumCardWidth: number) => {
    await expect
      .poll(async () =>
        tagRows.evaluate((element) => {
          const row = element.firstElementChild;
          return new Set(Array.from(row?.children ?? []).map((child) => Math.round(child.getBoundingClientRect().top)))
            .size;
        }),
      )
      .toBe(rows);
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
  // The Local scope already implies Local and remote catalog listings are no exception, so the cover stays clear.
  await expect(card.getByRole("img", { name: /^(Local|Remote)/ })).toHaveCount(0);
  await (
    await openLibraryView(page)
  )
    .getByRole("radiogroup", { name: "Cover source marks" })
    .getByRole("radio", { name: "Always show every source mark" })
    .click();
  await closeLibraryView(page);
  // Every mark shows as an icon; a narrow cover keeps two and counts the rest.
  await expect(card.getByRole("img", { name: /^Local/ })).toBeVisible();
  await expect(card.getByRole("img", { name: "Remote A", exact: true })).toBeVisible();
  await expect(card.getByRole("img", { name: "Remote B", exact: true })).toBeHidden();
  await expect(card.getByText("+1", { exact: true })).toBeVisible();
  // A two-column phone card spends one row on tags and leads with the user's own tags.
  await assertTagRowsAreComplete(1, 160, 200);
  await expect(tagRows.getByRole("button", { name: "Personal tag 1", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Personal tag 10", exact: true })).toHaveCount(0);

  let overflow = page.locator('button[aria-label^="Show "][aria-label$=" more tags"]');
  await expect(overflow).toBeVisible();
  await overflow.click();
  await expect(page.getByRole("button", { name: "Personal tag 10", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Long metadata tag 14", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1600, height: 900 });
  await assertTagRowsAreComplete(2, 210, 280);
  await expect(card.getByRole("img", { name: "Remote B", exact: true })).toBeVisible();
  await expect(card.getByText("+1", { exact: true })).toBeHidden();
  await expect(card.getByRole("button", { name: "Personal tag 10", exact: true })).toBeVisible();

  overflow = page.locator('button[aria-label^="Show "][aria-label$=" more tags"]');
  await expect(overflow).toBeVisible();
  await overflow.click();
  await expect(page.getByRole("button", { name: "Long metadata tag 14", exact: true })).toBeVisible();
});

test("a card names its lists beside the list icon only while the footer has room", async ({ page }) => {
  const memberLists = [
    { id: 1, name: "Synthetic list" },
    { id: 2, name: "Synthetic smart list" },
  ];
  await mockApplication(page, undefined, false, 1, 0, [], undefined, {
    work: { ...work, favorite: true, memberLists } as typeof work,
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await showFullWorkCards(page);
  await page.goto("/?mobileColumns=2&desktopColumns=4");

  const card = page.getByTestId("work-card").first();
  const listButton = card.getByRole("button", { name: "Lists: Synthetic list and Synthetic smart list", exact: true });
  await expect(listButton.getByText("Synthetic list", { exact: true })).toBeVisible();
  await expect(listButton.getByText("+1", { exact: true })).toBeVisible();
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  // A two-column phone card has no room for the name, so only the lit icon stays.
  await page.setViewportSize({ width: 412, height: 915 });
  await expect(listButton.getByText("Synthetic list", { exact: true })).toHaveCount(0);
  await expect(listButton).toBeVisible();
  expect((await listButton.boundingBox())?.width).toBeLessThanOrEqual(33);
});

test("@desktop recently played opens from a toolbar popover and returns to the work", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
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
  const recentlyPlayed = page.getByRole("button", { name: "Recently played", exact: true });
  await expect(recentlyPlayed).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Open Short title" })).toHaveCount(0);

  const openRecentlyPlayed = () => recentlyPlayed.click();
  await openRecentlyPlayed();
  const popover = page.getByRole("dialog", { name: "Recently played" });
  await expect(popover).toBeVisible();
  await expect(popover.getByRole("button", { name: "Open Short title" })).toBeVisible();
  await expect(
    popover.getByRole("button", { name: "Open A deliberately long title that occupies both reserved title lines" }),
  ).toBeVisible();
  await expect(popover.getByText("Track one · 0:42 / 2:00", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  await openRecentlyPlayed();
  await popover.getByRole("button", { name: "Open Short title" }).click();
  await expect(popover).toBeHidden();
  await expect(page).toHaveURL(/\/RJ00000060(?:\?|$)/);
});

test("recently played opens as a sheet from the phone toolbar and returns to the work", async ({ page }) => {
  const recentWorks = [
    {
      ...work,
      id: 21,
      primaryCode: "RJ00000060",
      title: "Short title",
      progress: {
        ...work.progress,
        title: "Disc 1/Track one",
        positionSeconds: 42,
        durationSeconds: 120,
        lastPlayedAt: "2026-01-02T00:00:00Z",
      },
    },
  ];
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { recentWorks });

  await page.goto("/library");
  await expect(page.getByRole("button", { name: "Open Short title" })).toHaveCount(0);

  let historyReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/recently-played-works") historyReads += 1;
  });
  const recentlyPlayed = page.getByRole("button", { name: "Recently played", exact: true });
  await recentlyPlayed.click();
  const recent = page.getByRole("dialog", { name: "Recently played" });
  const entry = recent.getByRole("button", { name: "Open Short title" });
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page).toHaveURL(/\/RJ00000060(?:\?|$)/);

  // Playing elsewhere moves the history, so the list is read again each time it opens.
  const readsBeforeReturn = historyReads;
  await page.goBack();
  await expect(recent).toHaveCount(0);
  await recentlyPlayed.click();
  await expect(entry).toBeVisible();
  await expect.poll(() => historyReads).toBeGreaterThan(readsBeforeReturn);
});

test("the phone Mark filter filters by Quick mark from the toolbar and is the one place the filter shows", async ({
  page,
}) => {
  const statuses: string[] = [];
  await mockApplication(page, (url) => {
    if (url.searchParams.get("scope") === "local") statuses.push(url.searchParams.get("status") ?? "");
  });
  await page.goto("/");
  await expect(page.getByTestId("work-card").first()).toBeVisible();

  const menu = page.getByRole("dialog", { name: "Mark filter", exact: true });
  await page.getByRole("button", { name: "Mark filter", exact: true }).click();
  await menu.getByRole("button", { name: "Listening", exact: true }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => statuses.at(-1)).toBe("listening");

  // The button names the filter in effect; nothing else on the page repeats it.
  const active = page.getByRole("button", { name: "Mark filter: Listening", exact: true });
  await expect(active).toBeVisible();
  await expect(page.getByText("Mark filter: Listening", { exact: true })).toHaveCount(0);

  await active.click();
  await expect(menu.getByRole("button", { name: "Listening", exact: true })).toHaveAttribute("aria-pressed", "true");
  await menu.getByRole("button", { name: "All", exact: true }).click();
  await expect.poll(() => statuses.at(-1)).toBe("all");
  await expect(page.getByRole("button", { name: "Mark filter", exact: true })).toBeVisible();
});

test("compact card mode turns phone cards into rows or tiles and is remembered", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");
  const card = page.getByTestId("work-card").first();
  await expect(card).toBeVisible();
  // Full cards are the default.
  await expect(card).not.toHaveAttribute("data-card-layout");

  await openLibraryView(page);
  await page.getByRole("radio", { name: /^Compact cards/ }).click();
  await expect(card).toHaveAttribute("data-card-layout", "row");
  await page.getByRole("radio", { name: "2 columns" }).click();
  await expect(card).toHaveAttribute("data-card-layout", "tile");

  await page.reload();
  await expect(page.getByTestId("work-card").first()).toHaveAttribute("data-card-layout", "tile");
});

test("@desktop mini card mode leaves the cover and title and is remembered", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await page.goto("/");
  const card = page.getByTestId("work-card").first();
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: work.circle, exact: true })).toBeVisible();

  // Automatic columns count the grid tracks, empty ones included.
  const autoTracks = () =>
    card.evaluate(
      (element) =>
        getComputedStyle(element.closest("[style*='--desktop-grid-template']")!).gridTemplateColumns.split(" ").length,
    );
  const fullTracks = await autoTracks();

  await openLibraryView(page);
  await page.getByRole("radio", { name: /^Compact cards/ }).click();
  await expect(card).toHaveAttribute("data-card-layout", "tile");
  await page.getByRole("radio", { name: /^Mini cards/ }).click();
  await expect(card).toHaveAttribute("data-card-layout", "cover");
  // Mini keeps automatic columns, which fit more covers, and starts from more
  // works per page without cover source marks.
  await expect(page.getByRole("radio", { name: "Automatic columns" })).toHaveAttribute("aria-checked", "true");
  await expect.poll(autoTracks).toBeGreaterThan(fullTracks);
  expect(await autoTracks()).toBeLessThanOrEqual(7);
  await expect(page.getByRole("radio", { name: "48 per page" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "Never show source marks" })).toHaveAttribute("aria-checked", "true");
  await expect(card.getByRole("heading", { name: work.title })).toBeVisible();
  await expect(card.getByRole("button", { name: work.circle, exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Add to list" })).toHaveCount(0);

  await page.reload();
  const restored = page.getByTestId("work-card").first();
  await expect(restored).toHaveAttribute("data-card-layout", "cover");
  await restored.getByRole("heading", { name: work.title }).click();
  await expect(page).toHaveURL(new RegExp(`/${work.primaryCode}(?:\\?|$)`));
});

test("the add-to-list picker opens as a bottom sheet inside the viewport on phones", async ({ page }) => {
  await mockApplication(page);
  await showFullWorkCards(page);
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Add to list" });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const sheet = page.getByRole("dialog", { name: "Add to list" });
  await expect(sheet).toBeVisible();
  // Phones keep the keyboard closed until the search is tapped.
  await expect(sheet.getByRole("combobox")).not.toBeFocused();
  const [sheetBox, viewport] = await Promise.all([
    sheet.boundingBox(),
    page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
  ]);
  expect(sheetBox).not.toBeNull();
  expect(sheetBox!.x).toBeGreaterThanOrEqual(0);
  expect(sheetBox!.x + sheetBox!.width).toBeLessThanOrEqual(viewport.width);
  await expect
    .poll(async () => (await sheet.boundingBox())!.y + (await sheet.boundingBox())!.height)
    .toBeLessThanOrEqual(viewport.height);
});

test("library search follows the user across scopes and survives navigation", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");

  const search = page.getByRole("searchbox", { name: "Search library" });
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
  await search.fill("local term");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("local term");
  await selectLibrarySource(page, "Tracked");
  await expect(search).toHaveValue("local term");
  await search.fill("tracked term");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("tracked term");
  await selectLibrarySource(page, "Local");
  await expect(search).toHaveValue("tracked term");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("tracked term");
  await page.reload();
  await expect(search).toHaveValue("tracked term");
});

test("touch text controls use 16px text so focusing them does not zoom the page", async ({ page }) => {
  await mockApplication(page);
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search library" });
  await expect(search).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("dialog", { name: "Account" }).getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();

  // iOS WebKit zooms into a focused control whose text is under 16px and stays zoomed.
  for (const control of [search, page.getByLabel("Username"), page.getByLabel("Password")]) {
    expect(await control.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(
      16,
    );
  }
});

test("library search conditions use accessible select menus", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await mockApplication(page);
  await page.goto("/");

  const searchBox = page.getByRole("searchbox", { name: "Search library" });
  const searchBoundsBeforeEditor = await searchBox.boundingBox();
  await page.getByRole("button", { name: "Add search condition" }).click();

  const clauseDialog = page.getByRole("dialog", { name: "Add search condition" });
  await expect(clauseDialog).toBeVisible();
  const clauseType = clauseDialog.getByRole("combobox", { name: "Search clause type" });
  await expect(clauseType).toHaveText("Text");
  await expect(clauseDialog.getByPlaceholder("Value")).toBeFocused();
  const toolbar = page.locator("[data-toast-avoid]").filter({ has: searchBox });
  const view = toolbar.getByRole("button", { name: "View", exact: true });
  await expect(view).toBeVisible();
  const [viewBounds, searchBoxBounds] = await Promise.all([view.boundingBox(), searchBox.boundingBox()]);
  expect(viewBounds).not.toBeNull();
  expect(searchBoxBounds).not.toBeNull();
  // Search leads the phone toolbar; View, which holds every other browse control, sits below it.
  expect(searchBoxBounds!.y + searchBoxBounds!.height).toBeLessThanOrEqual(viewBounds!.y);
  // The editor floats below the search field instead of inserting a page row.
  expect(searchBoxBounds).toEqual(searchBoundsBeforeEditor);
  const dialogBox = await clauseDialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.y).toBeGreaterThanOrEqual(searchBoxBounds!.y + searchBoxBounds!.height);
  expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  await page.keyboard.press("Escape");
  await expect(clauseDialog).toHaveCount(0);
  await expect(searchBox).toBeVisible();
  await page.getByRole("button", { name: "Add search condition" }).click();
  await expect(clauseType).toHaveText("Text");

  const clauseTypeBox = await clauseType.boundingBox();
  const clauseValueBox = await clauseDialog.getByPlaceholder("Value").boundingBox();
  expect(clauseTypeBox).not.toBeNull();
  expect(clauseValueBox).not.toBeNull();
  expect(Math.abs(clauseTypeBox!.y - clauseValueBox!.y)).toBeLessThan(1);
  expect(Math.abs(clauseTypeBox!.height - clauseValueBox!.height)).toBeLessThan(1);
  await clauseType.click();
  await page.getByRole("listbox").getByRole("option", { name: "On shelf", exact: true }).click();
  await expect(clauseDialog).toBeVisible();

  const shelfMembership = clauseDialog.getByRole("combobox", { name: "Shelf membership" });
  await expect(shelfMembership).toHaveText("Included");
  await shelfMembership.click();
  const membershipOptions = page.getByRole("listbox");
  await expect(membershipOptions.getByRole("option", { name: "Included", exact: true })).toBeVisible();
  await expect(membershipOptions.getByRole("option", { name: "Not included", exact: true })).toBeVisible();
  await membershipOptions.getByRole("option", { name: "Not included", exact: true }).click();
  await expect(shelfMembership).toHaveText("Not included");

  await clauseDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(clauseDialog).toHaveCount(0);

  await page.getByRole("button", { name: "Add search condition" }).click();
  await clauseDialog.getByPlaceholder("Value").fill("rain");
  await clauseDialog.getByPlaceholder("Value").press("Enter");
  await expect(clauseDialog).toHaveCount(0);
  await expect(searchBox).toHaveValue("rain");

  await page.getByRole("button", { name: "Text: rain", exact: true }).click();
  const editDialog = page.getByRole("dialog", { name: "Edit search condition" });
  await expect(editDialog.getByPlaceholder("Value")).toHaveValue("rain");
  await page.keyboard.press("Escape");
  await expect(editDialog).toHaveCount(0);
});

test("anonymous quick marks open the sign-in flow from mobile controls", async ({ page }) => {
  await mockApplication(page);
  await showFullWorkCards(page);
  await page.goto("/");

  await page.getByRole("button", { name: "Mark: Unmarked" }).click();
  // The toolbar's Mark filter options share these names; the card's menu is the floating layer.
  const markMenu = page.locator(".fixed.z-50").filter({ hasText: "Relisten" });
  await expect(markMenu.getByRole("button", { name: "Unmarked", exact: true })).toHaveClass(/bg-primary\/10/);
  await markMenu.getByRole("button", { name: "Want", exact: true }).click();
  await expect(page.getByText("Sign in is required.", { exact: true })).toBeVisible();
  await page.locator('[aria-live="polite"]').getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Kikoto" })).toBeVisible();
});

test("@desktop anonymous quick marks open the sign-in flow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mockApplication(page);
  await showFullWorkCards(page);
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
    route.fulfill({ status: 500, json: { error: "database temporarily unavailable" } satisfies ApiErrorBody }),
  );
  await page.goto("/");

  await expect(page.getByText("Library could not be loaded.")).toBeVisible();
  await expect(page.getByText("database temporarily unavailable")).toBeVisible();
  await expect(page.getByText("No local works match this view.")).toBeHidden();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
