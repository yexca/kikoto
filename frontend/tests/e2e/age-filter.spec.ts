import { expect, test } from "@playwright/test";
import { workDetailFixture } from "./fixtures/api";
import { mockApplication, work } from "./fixtures/player-library";

test("age rating chip filters the library without opening the work", async ({ page }) => {
  const requests: string[] = [];
  await mockApplication(page, (url) => requests.push(url.searchParams.get("q") ?? ""), false, 1, 0, [], undefined, {
    work: { ...work, ageRating: "adult" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Age: R18", exact: true }).click();
  await expect.poll(() => requests).toContain("$age:adult$");
  await expect(page).toHaveURL(/\/\?q=age%3Aadult$/);
  await expect(page.getByText(work.title, { exact: true })).toBeVisible();
});

test("age rating search offers categories and applies the selected value", async ({ page }) => {
  const requests: string[] = [];
  await mockApplication(page, (url) => requests.push(url.searchParams.get("q") ?? ""));
  await page.goto("/");
  await page.getByRole("button", { name: "Search library", exact: true }).click();
  await page.getByRole("button", { name: "Add search condition", exact: true }).click();
  await page.getByRole("combobox", { name: "Search clause type", exact: true }).click();
  await page.getByRole("option", { name: "Age", exact: true }).click();
  await page.getByRole("combobox", { name: "Age", exact: true }).click();
  await page.getByRole("option", { name: "R18", exact: true }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => requests).toContain("$age:adult$");
});

test("age rating in work detail searches the tracked library it was opened from", async ({ page }) => {
  const requests: string[] = [];
  await mockApplication(page, (url) => requests.push(url.searchParams.get("q") ?? ""));
  await page.route(/\/api\/works\/1(?:\?.*)?$/, (route) =>
    route.fulfill({ json: workDetailFixture(work, { ageRating: "adult" }) }),
  );
  await page.goto("/tracked");
  await page.getByText(work.title, { exact: true }).click();
  await page.getByRole("main").getByRole("button", { name: "Age: R18", exact: true }).click();
  await expect(page).toHaveURL(/\/tracked\?q=age%3Aadult$/);
  await expect.poll(() => requests).toContain("$age:adult$");
});
