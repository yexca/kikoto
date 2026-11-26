import assert from "node:assert/strict";
import test from "node:test";

import { compare, lineCount, lowered, measured } from "./check-file-size.mjs";

test("measures backend Go and frontend source, not tests, locale tables, or fixtures", () => {
  assert.equal(measured("backend/internal/a/store.go"), true);
  assert.equal(measured("backend/internal/a/store_test.go"), false);
  assert.equal(measured("frontend/src/features/a/Page.tsx"), true);
  assert.equal(measured("frontend/src/lib/model.ts"), true);
  assert.equal(measured("frontend/src/lib/model.test.ts"), false);
  assert.equal(measured("frontend/src/i18n/surfaces/en.ts"), false);
  assert.equal(measured("frontend/src/test-support/render.tsx"), false);
  assert.equal(measured("frontend/tests/e2e/a.spec.ts"), false);
  assert.equal(measured("scripts/check.mjs"), false);
});

test("counts lines with either line ending and a final line without a newline", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\r\nb\r\nc"), 3);
});

test("fails a new file over the limit and a recorded file that grew", () => {
  const { failures, stale } = compare(
    { "new.go": 11, "old.go": 13, "kept.go": 12 },
    { "old.go": 12, "kept.go": 12 },
    10,
  );
  assert.deepEqual(failures, [
    "new.go has 11 lines, above the 10-line limit",
    "old.go grew to 13 lines, baseline allows 12",
  ]);
  assert.deepEqual(stale, []);
});

test("holds the baseline to the code: a shrunk, split, or deleted file must be recorded lower", () => {
  const sizes = { "shrunk.go": 15, "split.go": 9, "same.go": 20 };
  const baseline = {
    "shrunk.go": 18,
    "split.go": 30,
    "gone.go": 40,
    "same.go": 20,
  };
  assert.deepEqual(compare(sizes, baseline, 10).stale, [
    "shrunk.go has 15 lines, baseline allows 18",
    "split.go has 9 lines, baseline allows 30",
    "gone.go is gone, baseline allows 40",
  ]);
  assert.deepEqual(lowered(sizes, baseline, 10), {
    "shrunk.go": 15,
    "same.go": 20,
  });
  assert.deepEqual(lowered({ "grew.go": 25 }, { "grew.go": 20 }, 10), {
    "grew.go": 20,
  });
});
