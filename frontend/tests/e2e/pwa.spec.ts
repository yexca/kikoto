import { expect, test } from "@playwright/test";

test("PWA metadata exposes install icons and the worker excludes API and range requests", async ({ request }) => {
  const indexResponse = await request.get("/");
  expect(indexResponse.ok()).toBe(true);
  expect(await indexResponse.text()).toContain("viewport-fit=cover");

  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = (await manifestResponse.json()) as {
    display: string;
    icons: Array<{ sizes: string; purpose: string }>;
  };
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.some((icon) => icon.sizes === "192x192")).toBe(true);
  expect(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable")).toBe(true);

  const workerResponse = await request.get("/sw.js");
  expect(workerResponse.ok()).toBe(true);
  const worker = await workerResponse.text();
  expect(worker).toContain('url.pathname.startsWith("/api/")');
  expect(worker).toContain('request.headers.has("range")');
});
