import { expect, test } from "@playwright/test";

for (const width of [320, 393]) {
  test(`native server connection fits a ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.addInitScript(() => {
      localStorage.setItem("kikoto:ui-locale", "en");
      // Model the native bridge while keeping this layout test offline.
      Object.assign(window, {
        androidBridge: {},
        Capacitor: {
          PluginHeaders: [
            { name: "Preferences", methods: [{ name: "get", rtype: "promise" }] },
            { name: "KikotoAssetTransport", methods: [{ name: "clear", rtype: "promise" }] },
          ],
          nativePromise: async (plugin: string) => (plugin === "Preferences" ? { value: null } : undefined),
        },
      });
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Connect to Kikoto" })).toBeVisible();

    const address = page.getByRole("textbox", { name: "Server address" });
    const protocol = page.getByRole("combobox", { name: "Protocol" });
    const port = page.getByRole("textbox", { name: "Port", exact: true });
    await address.fill("server.example.invalid/kikoto");
    await protocol.selectOption("https");
    await port.fill("65535");

    for (const control of [address, protocol, port, page.getByRole("button", { name: "Connect", exact: true })]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
