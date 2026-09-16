import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkFile } from "./check-doc-links.mjs";

test("relocated README navigation and images are checked alongside Markdown links", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kikoto-doc-links-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "README.md",
    "docs/development/design.md",
    "docs/assets/example image.svg",
  ]) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "Example fixture");
  }
  const readme = path.join(root, "docs/readme/README.zh-Hans.md");
  fs.mkdirSync(path.dirname(readme), { recursive: true });
  fs.writeFileSync(
    readme,
    [
      "[English](../../README.md)",
      '<a href="../../README.md">English</a>',
      "<a",
      '  href="../development/design.md#rules">Design</a>',
      '<img src="../assets/example%20image.svg" alt="Example">',
      '<a href="./missing.md">Missing translation</a>',
      '<img src="../assets/missing.svg" alt="Missing image">',
      "[Missing Markdown](../missing.md)",
      '<a href="https://example.invalid/README.md">External</a>',
      '<a href="#local">Section</a>',
      "```html",
      '<a href="ignored.md">Code example</a>',
      "```",
      "[Repository root](/README.md)",
    ].join("\n"),
  );
  assert.deepEqual(
    checkFile(readme, root).map(({ line, target }) => ({ line, target })),
    [
      { line: 6, target: "./missing.md" },
      { line: 7, target: "../assets/missing.svg" },
      { line: 8, target: "../missing.md" },
    ],
  );
});
