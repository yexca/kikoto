import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scan, selectsByClass, violations } from "./check-e2e-locators.mjs";

test("flags fixed sleeps but not a comment that names one", () => {
  const source = [
    "// waitForTimeout(100) is what this used to do.",
    "await page.waitForTimeout(300);",
    "await page.clock.runFor(300);",
  ].join("\n");

  assert.deepEqual(
    violations(source).map((violation) => violation.line),
    [2],
  );
});

test("flags a locator that selects by utility or component class", () => {
  for (const selector of [
    ".fixed.z-50",
    "section.fixed.inset-0",
    "div.inline-flex",
    ".app-main",
    ".app-shell > aside",
    ":has(.mini-player)",
    "[class*='grid-template-columns']",
    'section[class~="grid"]',
    "css=.mini-player",
    "xpath=ancestor::div[contains(@class, 'fixed')]",
    "//div[@class='fixed']",
    ".lg\\:flex",
  ]) {
    assert.equal(selectsByClass(selector), true, selector);
    assert.equal(
      violations(`page.locator(${JSON.stringify(selector)});`).length,
      1,
      selector,
    );
  }
});

test("allows tags, attributes, other engines, and quoted values", () => {
  for (const selector of [
    "footer",
    "audio",
    "html",
    '[data-player-surface="compact"]',
    '[data-marquee="auto"] [data-marquee-track]',
    '[aria-live="polite"]',
    "section[data-browse-page]",
    'button:has-text("Save.")',
    'a[href$=".pdf"]',
    "text=Done.",
    "data-testid=work.card",
    "role=button",
    "xpath=//section",
    "xpath=ancestor::section[@data-player-surface]",
  ]) {
    assert.equal(selectsByClass(selector), false, selector);
  }
});

test("reads the selector, not the filter options or interpolated code", () => {
  const source = [
    'page.locator(\'[data-marquee="auto"]\', { hasText: "a.b" });',
    'page.locator(`[data-lyric-index="${activeIndex.toFixed(0)}"]`);',
    "page.locator(selector);",
    "page.locator(`.item-${index}`);",
  ].join("\n");

  assert.deepEqual(
    violations(source).map((violation) => violation.line),
    [4],
  );
});

test("reports a locator whose selector sits on the next line", () => {
  const source = ["page", "  .locator(", '    ".fixed.z-50",', "  );"].join(
    "\n",
  );

  assert.deepEqual(
    violations(source).map((violation) => violation.line),
    [2],
  );
});

test("scans every TypeScript file under the tests directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kikoto-e2e-locators-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "e2e", "fixtures"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "e2e", "clean.spec.ts"),
    'await page.getByRole("button", { name: "Save" }).click();\n',
  );
  fs.writeFileSync(
    path.join(root, "e2e", "fixtures", "helper.ts"),
    "await page.waitForTimeout(50);\n",
  );

  const found = scan(root);

  assert.equal(found.length, 1);
  assert.match(found[0].file, /fixtures\/helper\.ts$/u);
  assert.equal(found[0].line, 1);
});
