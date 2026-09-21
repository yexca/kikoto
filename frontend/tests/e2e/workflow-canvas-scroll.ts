import { expect, type Locator, type Page } from "@playwright/test";

export async function expectCooperativeCanvasScroll(
  page: Page,
  canvas: Locator,
  scrolls = true,
  requiresModifier = true,
) {
  await canvas.scrollIntoViewIfNeeded();
  const viewport = canvas.locator(".react-flow__viewport");
  await expect(viewport).toHaveAttribute("style", /transform:/);
  const transform = await viewport.getAttribute("style");
  const scrollPosition = () =>
    canvas.evaluate((element) => {
      let offset = 0;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) offset += parent.scrollTop;
      return offset;
    });
  const moveToCanvas = async () => {
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  };
  await moveToCanvas();
  const beforeScroll = await scrollPosition();
  await page.mouse.wheel(0, 80);
  if (requiresModifier) {
    await expect(canvas.getByRole("status")).toContainText(/Hold (Ctrl|⌘) and scroll/);
    if (scrolls) await expect.poll(scrollPosition).toBeGreaterThan(beforeScroll);
    await expect(viewport).toHaveAttribute("style", transform!);
  } else {
    await expect(viewport).not.toHaveAttribute("style", transform!);
    expect(await scrollPosition()).toBe(beforeScroll);
    await expect(canvas.getByRole("status")).toBeEmpty();
    return;
  }

  for (const modifier of ["Control", "Meta"]) {
    await canvas.scrollIntoViewIfNeeded();
    await moveToCanvas();
    const beforeZoom = await viewport.getAttribute("style");
    const beforeZoomScroll = await scrollPosition();
    await page.keyboard.down(modifier);
    try {
      await page.mouse.wheel(0, 80);
      await expect(viewport).not.toHaveAttribute("style", beforeZoom!);
      await expect(canvas.getByRole("status")).toBeEmpty();
      expect(await scrollPosition()).toBe(beforeZoomScroll);
    } finally {
      await page.keyboard.up(modifier);
    }
  }

  const afterZoom = await viewport.getAttribute("style");
  await page.mouse.wheel(0, 40);
  await expect(canvas.getByRole("status")).toContainText(/Hold (Ctrl|⌘) and scroll/);
  await expect(canvas.getByRole("status")).toBeEmpty();
  await expect(viewport).toHaveAttribute("style", afterZoom!);
}
