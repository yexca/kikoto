import { expect, test } from "@playwright/test";
import { mediaFixture, mockApplication, work } from "./fixtures/player-library";
import { worksPageFixture } from "./fixtures/api";
import { defaultLibraryBrowseState } from "../../src/lib/libraryBrowseState";

for (const direct of [false, true]) {
  test(`${direct ? "direct code" : "known work"} starts its directory while summary is pending`, async ({ page }) => {
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    let summaryRequests = 0;
    let mediaRequests = 0;
    let resolveRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/works/RJ00000000/resolve") resolveRequests++;
    });
    await mockApplication(
      page,
      undefined,
      false,
      1,
      0,
      [mediaFixture(1, "track.mp3", "RJ00000000/track.mp3", "audio")],
      undefined,
      {
        authenticated: true,
        beforeWorkDetailResponse: async () => {
          summaryRequests++;
          await summaryGate;
        },
        onMediaRequest: () => {
          mediaRequests++;
        },
      },
    );
    try {
      await page.goto(direct ? "/RJ00000000" : "/");
      if (!direct) await page.getByText(work.title, { exact: true }).click();
      await expect.poll(() => summaryRequests).toBeGreaterThan(0);
      await expect.poll(() => mediaRequests).toBeGreaterThan(0);
      releaseSummary();
      await expect(page.getByTestId("directory-file-row").filter({ hasText: "track.mp3" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Mark: Unmarked" })).toBeVisible();
      if (direct) expect(resolveRequests).toBe(0);
    } finally {
      releaseSummary();
    }
  });
}

test("local list restores saved controls while source configuration is pending", async ({ page }) => {
  await page.addInitScript(
    (state) => {
      const key = `kikoto:library-browse:${encodeURIComponent(location.origin)}:user-1:scope:local`;
      sessionStorage.setItem(key, JSON.stringify(state));
    },
    { ...defaultLibraryBrowseState, page: 2, sort: "title", direction: "asc", status: "finished" },
  );
  await mockApplication(page, undefined, false, 1, 0, [], undefined, { authenticated: true });
  const requests: URL[] = [];
  await page.route("**/api/works?**", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("scope") !== "local") return route.fallback();
    requests.push(url);
    return route.fulfill({ json: worksPageFixture([work], { page: 2, total: 100 }) });
  });
  let releaseSources!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSources = resolve;
  });
  await page.route("**/api/library-sources", async (route) => {
    await gate;
    await route.fallback();
  });
  try {
    await page.goto("/");
    await expect(page.getByText(work.title, { exact: true })).toBeVisible();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests)
      expect(Object.fromEntries(request.searchParams)).toMatchObject({
        page: "2",
        sort: "title",
        direction: "asc",
        status: "finished",
        scope: "local",
      });
    const beforeSources = requests.length;
    const sourcesLoaded = page.waitForResponse("**/api/library-sources");
    releaseSources();
    await sourcesLoaded;
    await expect(page.getByRole("button", { name: "Local", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Sort: Title", exact: true })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Pages", exact: true }).getByRole("button", { name: "Page 2", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    expect(requests).toHaveLength(beforeSources);
  } finally {
    releaseSources();
  }
});
