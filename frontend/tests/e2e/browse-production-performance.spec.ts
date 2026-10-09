import { expect, test } from "@playwright/test";
import { mediaFixture, mockApplication, silentWav } from "./fixtures/player-library";

test.use({ serviceWorkers: "block" });

// Built assets, real React rendering and browser audio; controlled API boundary.
// The live-backend audio experiment is separate from this network-path experiment.
test("production direct-link critical path @desktop", async ({ page }) => {
  test.skip(process.env.KIKOTO_PRODUCTION_PERF !== "1", "opt-in production performance experiment");
  expect(process.env.PLAYWRIGHT_BASE_URL).toBeTruthy();
  test.setTimeout(180_000);
  const samples: Record<string, number[]> = {};
  const traces: unknown[] = [];
  const record = (name: string, value: number) => (samples[name] ??= []).push(value);
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
    const marks = window as Window & { summaryPaint?: number; directoryPaint?: number };
    const visible = (element: Element | null) => Boolean(element && element.getClientRects().length);
    const observer = new MutationObserver(() => {
      const summary = document.querySelector('button[aria-label="Mark: Unmarked"]');
      const directory = document.querySelector('[data-testid="directory-file-row"]');
      if (!marks.summaryPaint && visible(summary))
        requestAnimationFrame(() => {
          marks.summaryPaint ??= performance.now();
        });
      if (!marks.directoryPaint && visible(directory))
        requestAnimationFrame(() => {
          marks.directoryPaint ??= performance.now();
        });
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    document.addEventListener("click", (event) => {
      if ((event.target as Element | null)?.closest('[data-testid="directory-file-row"]')) {
        (window as Window & { clickAt?: number }).clickAt = performance.now();
      }
    });
  });
  for (const delay of [0, 200]) {
    for (let sample = 0; sample < 20; sample++) {
      await page.unrouteAll({ behavior: "wait" });
      await mockApplication(
        page,
        undefined,
        false,
        1,
        0,
        [mediaFixture(1, "track.wav", "RJ00000000/track.wav", "audio")],
        undefined,
        { authenticated: true },
      );
      const requests: Array<{ path: string; start: number; end?: number }> = [];
      const starts = new Map<string, number>();
      const opened = performance.now();
      const onRequest = (request: import("@playwright/test").Request) => {
        const path = new URL(request.url()).pathname;
        if (!path.startsWith("/api/")) return;
        requests.push({ path, start: performance.now() - opened });
        starts.set(request.url(), requests.length - 1);
      };
      const onFinished = (request: import("@playwright/test").Request) => {
        const i = starts.get(request.url());
        if (i !== undefined) requests[i].end = performance.now() - opened;
      };
      page.on("request", onRequest);
      page.on("requestfinished", onFinished);
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        await new Promise((resolve) => setTimeout(resolve, path === "/api/library-sources" ? delay * 3 : delay));
        await route.fallback();
      });
      await page.route("**/api/media/1/stream**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        await route.fulfill({ contentType: "audio/wav", body: silentWav(5) });
      });
      try {
        await page.goto("/RJ00000000", { waitUntil: "commit" });
        await expect(page.getByRole("button", { name: "Mark: Unmarked" })).toBeVisible();
        record(`delay=${delay}/summary-rendered`, performance.now() - opened);
        const row = page.getByTestId("directory-file-row").filter({ hasText: "track.wav" });
        await expect(row).toBeVisible();
        record(`delay=${delay}/directory-operable`, performance.now() - opened);
        await expect
          .poll(() => page.evaluate(() => (window as Window & { directoryPaint?: number }).directoryPaint))
          .toBeTruthy();
        const paint = await page.evaluate(() => {
          const marks = window as Window & { summaryPaint?: number; directoryPaint?: number };
          return { summary: marks.summaryPaint, directory: marks.directoryPaint };
        });
        expect(paint.summary).toBeTruthy();
        record(`delay=${delay}/summary-paint-frame`, paint.summary!);
        record(`delay=${delay}/directory-paint-frame`, paint.directory!);
        const stages = requests.filter(({ path }) => /^\/api\/works\/(1|RJ00000000)(\/resolve|\/media)?$/.test(path));
        traces.push({ delay, sample, stages });
        record(`delay=${delay}/detail-requests`, stages.length);
        for (const { path, start, end } of stages) {
          if (end !== undefined) record(`delay=${delay}/request${path}`, end - start);
        }
        await page.evaluate(() => {
          document.querySelector("audio")!.addEventListener(
            "playing",
            () => {
              (window as Window & { playingAt?: number }).playingAt = performance.now();
            },
            { once: true },
          );
        });
        await row.click();
        await expect
          .poll(() => page.evaluate(() => (window as Window & { playingAt?: number }).playingAt))
          .toBeTruthy();
        record(
          `delay=${delay}/click-to-playing`,
          await page.evaluate(() => {
            const state = window as Window & { clickAt?: number; playingAt?: number };
            return state.playingAt! - state.clickAt!;
          }),
        );
      } finally {
        page.off("request", onRequest);
        page.off("requestfinished", onFinished);
      }
    }
  }
  for (const [name, values] of Object.entries(samples)) {
    values.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        name,
        n: values.length,
        errors: 0,
        p50: values[Math.floor((values.length - 1) * 0.5)],
        p95: values[Math.floor((values.length - 1) * 0.95)],
      }),
    );
  }
  console.log(
    JSON.stringify({
      traces,
      conditions:
        "production build; Chromium desktop; API delay 0/200ms, sources 0/600ms; origin language; fresh principal storage and media cache per navigation; service worker blocked; route interception disables browser HTTP cache; no server timings included",
    }),
  );
});
