import { createRequire } from "node:module";

const requireFrontend = createRequire(
  new URL("../frontend/package.json", import.meta.url),
);

export async function verifyProductionBrowser(baseURL, workCode, signal) {
  const { chromium, expect } = requireFrontend("@playwright/test");
  signal.throwIfAborted();
  const browser = await chromium.launch({ headless: true, timeout: 15_000 });
  const close = () => {
    void browser.close().catch(() => {});
  };
  const timeout = setTimeout(close, 60_000);
  signal.addEventListener("abort", close, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({
      baseURL,
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Sign in to Kikoto", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Username", { exact: true }).fill("synthetic-user");
    await page
      .getByLabel("Password", { exact: true })
      .fill("synthetic-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const card = page.getByTestId("work-card").filter({ hasText: workCode });
    await expect(card).toHaveCount(1);
    await card.getByRole("button", { name: new RegExp(workCode) }).click();
    await page.getByText("example.wav", { exact: true }).click();
    await expect
      .poll(() => page.locator("audio").evaluate((audio) => audio.currentTime))
      .toBeGreaterThan(0);
    await expect(page.locator("audio")).toHaveJSProperty("error", null);
    console.log(
      "Production browser smoke passed: real login, local work navigation and audio playback.",
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", close);
    await browser.close();
  }
}
