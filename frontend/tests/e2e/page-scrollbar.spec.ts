import { expect, test } from "@playwright/test";
import { mockApplication } from "./fixtures/player-library";

// Headless Chromium hides scrollbars by default; this file needs classic ones.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("@desktop the library keeps its width when the page starts scrolling", async ({ page }) => {
  // A width that changed with the scrollbar let a page near the viewport height
  // toggle the scrollbar on every frame.
  await page.setViewportSize({ width: 1280, height: 2000 });
  await mockApplication(page, undefined, false, 6);
  await page.goto("/");
  await expect(page.getByTestId("work-card")).toHaveCount(6);
  const pageMetrics = () =>
    page.evaluate(() => ({
      scrolls: document.documentElement.scrollHeight > window.innerHeight,
      contentWidth: document.body.getBoundingClientRect().width,
    }));
  const unscrolled = await pageMetrics();
  expect(unscrolled.scrolls).toBe(false);

  await page.setViewportSize({ width: 1280, height: 400 });
  await expect.poll(pageMetrics).toEqual({ scrolls: true, contentWidth: unscrolled.contentWidth });
});
