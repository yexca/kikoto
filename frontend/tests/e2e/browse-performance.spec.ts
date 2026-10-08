import { expect, test } from "@playwright/test";
import { mediaFixture, mockApplication, silentWav, work } from "./fixtures/player-library";

// Explicit latency experiment; normal CI uses the deterministic loading tests.
test("controlled network browsing timings @desktop", async ({ page }) => {
  test.skip(process.env.KIKOTO_BROWSE_PERF !== "1", "opt-in performance experiment");
  test.setTimeout(180_000);
  const samples: Record<string, number[]> = {};
  const requests: Record<string, number[]> = {};
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  for (const direct of [false, true]) {
    for (let sample = 0; sample < 12; sample++) {
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
      let detailRequests = 0;
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (/^\/api\/works\/(1|RJ00000000)(\/media|\/resolve)?$/.test(path)) detailRequests++;
        await new Promise((resolve) => setTimeout(resolve, path === "/api/library-sources" ? 600 : 200));
        await route.fallback();
      });
      await page.route("**/api/media/1/stream**", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({ contentType: "audio/wav", body: silentWav(5) });
      });
      const start = Date.now();
      await page.goto(direct ? "/RJ00000000" : "/", { waitUntil: "commit" });
      const record = (name: string, value: number) => (samples[name] ??= []).push(value);
      if (!direct) {
        await expect(page.getByText(work.title, { exact: true })).toBeVisible();
        record("list-visible", Date.now() - start);
      }
      const opened = Date.now();
      if (!direct) await page.getByText(work.title, { exact: true }).click();
      await expect(page.getByRole("button", { name: "Mark: Unmarked" })).toBeVisible();
      record(direct ? "direct-summary-visible" : "known-summary-visible", Date.now() - opened);
      const row = page.getByTestId("directory-file-row").filter({ hasText: "track.wav" });
      await expect(row).toBeVisible();
      record(direct ? "direct-directory-operable" : "known-directory-operable", Date.now() - opened);
      (requests[direct ? "direct-detail" : "known-detail"] ??= []).push(detailRequests);
      await page.evaluate(() => {
        const audio = document.querySelector("audio")!;
        audio.addEventListener(
          "playing",
          () => {
            (window as Window & { playingAt?: number }).playingAt = performance.now();
          },
          { once: true },
        );
      });
      const triggered = await page.evaluate(() => performance.now());
      await row.click();
      await expect.poll(() => page.evaluate(() => (window as Window & { playingAt?: number }).playingAt)).toBeTruthy();
      record(
        "trigger-to-playing",
        (await page.evaluate(() => (window as Window & { playingAt?: number }).playingAt!)) - triggered,
      );
    }
  }
  for (const [name, values] of Object.entries(samples)) {
    values.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        name,
        n: values.length,
        concurrency: 1,
        errors: 0,
        p50ms: values[Math.floor((values.length - 1) * 0.5)],
        p95ms: values[Math.floor((values.length - 1) * 0.95)],
      }),
    );
  }
  console.log(
    JSON.stringify({
      detailRequests: requests,
      apiDelayMs: 200,
      sourceDelayMs: 600,
      mediaCache: "cold on each navigation",
    }),
  );
});
