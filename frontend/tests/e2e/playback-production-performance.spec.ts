import { expect, test } from "@playwright/test";
import { mediaFixture, mockApplication } from "./fixtures/player-library";

test.use({ serviceWorkers: "block" });
test("production player against real playback handlers @desktop", async ({ page, request }) => {
  test.skip(process.env.KIKOTO_PLAYBACK_BROWSER_PERF !== "1", "started by the Go playback experiment");
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  for (const kind of ["local", "remote", "compatible-cold", "compatible-warm"] as const) {
    const times: number[] = [];
    const streams: number[] = [];
    for (let i = 0; i < (kind === "compatible-cold" ? 12 : 20); i++) {
      const compatible = kind.startsWith("compatible");
      if (compatible)
        expect((await request.get(`/api/perf/control?cold=${kind.endsWith("cold") ? 1 : 0}`)).status()).toBe(204);
      await page.unrouteAll({ behavior: "wait" });
      const item = mediaFixture(
        1,
        compatible ? "track.aac" : "track.wav",
        compatible ? "RJ00000000/track.aac" : "RJ00000000/track.wav",
        "audio",
      );
      item.locations[0].streamUrl = `/api/perf/${compatible ? "compatible" : kind}/stream?forceDirect=1`;
      await mockApplication(page, undefined, false, 1, 0, [item], undefined, { authenticated: true });
      await page.route("**/api/perf/**", (route) => route.continue());
      await page.goto("/RJ00000000");
      const row = page.getByTestId("directory-file-row").filter({ hasText: item.title });
      await expect(row).toBeVisible();
      let count = 0;
      const onRequest = (event: import("@playwright/test").Request) => {
        if (event.url().includes("/api/perf/") && event.url().includes("/stream")) count++;
      };
      page.on("request", onRequest);
      await page.evaluate(() => {
        const state = window as Window & { clickAt?: number; playingAt?: number };
        document.addEventListener(
          "click",
          (event) => {
            if ((event.target as Element | null)?.closest('[data-testid="directory-file-row"]'))
              state.clickAt = performance.now();
          },
          { once: true },
        );
        document.querySelector("audio")!.addEventListener(
          "playing",
          () => {
            state.playingAt = performance.now();
          },
          { once: true },
        );
      });
      await row.click();
      await expect.poll(() => page.evaluate(() => (window as Window & { playingAt?: number }).playingAt)).toBeTruthy();
      times.push(
        await page.evaluate(() => {
          const state = window as Window & { clickAt?: number; playingAt?: number };
          return state.playingAt! - state.clickAt!;
        }),
      );
      page.off("request", onRequest);
      streams.push(count);
    }
    times.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        kind,
        n: times.length,
        errors: 0,
        p50: times[Math.floor((times.length - 1) * 0.5)],
        p95: times[Math.floor((times.length - 1) * 0.95)],
        streamRequests: streams,
        conditions:
          "production Chromium desktop; app APIs mocked; real Go playback handlers; single-track queue, no next-track preload; source revision changed for cold; fresh browser storage, intercepted routes disable HTTP cache; remote configured loopback origin with 200ms delay; no NAS/mobile device",
      }),
    );
  }
});
