import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compare, findDuplicates } from "./check-duplicate-helpers.mjs";

function fixture(t, files) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "kikoto-duplicate-helpers-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  }
  return root;
}

test("counts a Go helper once per package and ignores per-platform variants", (t) => {
  const root = fixture(t, {
    "backend/internal/a/one.go":
      "package a\n\nfunc shared() {}\n\nfunc (s *S) method() {}\n",
    "backend/internal/b/two.go": "package b\n\nfunc shared() {}\n",
    "backend/internal/c/unix.go":
      "//go:build !windows\n\npackage c\n\nfunc platform() {}\n",
    "backend/internal/c/windows.go":
      "//go:build windows\n\npackage c\n\nfunc platform() {}\n",
    "backend/internal/d/one_test.go": "package d\n\nfunc shared() {}\n",
    "backend/internal/e/main.go":
      "package e\n\nfunc maxInt(a, b int) int { return max(a, b) }\n\nfunc main() {}\n",
  });

  const found = findDuplicates(root);
  assert.deepEqual(found.go, { shared: 2 });
  assert.deepEqual(found.builtinLookalikes, ["maxInt"]);
});

test("counts a TypeScript local function that hides an exported one", (t) => {
  const root = fixture(t, {
    "frontend/src/lib/icons.tsx":
      "export function fileIcon(kind: string) {\n  return kind;\n}\n",
    "frontend/src/features/a.tsx":
      "function fileIcon(kind: string) {\n  return kind;\n}\n",
    "frontend/src/features/b.ts":
      "const storageKey = (scope: string): string => `k:${scope}`;\nconst limit = 5;\n",
    "frontend/src/features/c.ts":
      "const storageKey = (scope: string): string => `c:${scope}`;\nconst limit = 5;\n",
    "frontend/src/features/c.test.ts": "function fileIcon() {}\n",
  });

  assert.deepEqual(findDuplicates(root).typescript, {
    fileIcon: 2,
    storageKey: 2,
  });
});

test("fails only on duplicates the baseline does not allow", () => {
  const actual = {
    go: { shared: 3 },
    typescript: { known: 2 },
    builtinLookalikes: ["minInt"],
  };
  const baseline = { go: { shared: 2 }, typescript: { known: 2, fixed: 2 } };

  const { failures, stale } = compare(actual, baseline);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /minInt/u);
  assert.match(
    failures[1],
    /shared is defined in 3 packages, baseline allows 2/u,
  );
  assert.equal(stale.length, 1);
  assert.match(stale[0], /fixed/u);
});
