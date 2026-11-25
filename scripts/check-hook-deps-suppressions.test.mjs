import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scan, violations } from "./check-hook-deps-suppressions.mjs";

const lines = (source) => violations(source).map((violation) => violation.line);

test("flags each form that silences the hook rule, the guard's own report included", () => {
  const source = [
    "useEffect(() => {",
    "  // eslint-disable-next-line react-hooks/exhaustive-deps",
    "}, []); // eslint-disable-line",
    "/* eslint-disable */",
    "}, []); // oxlint-disable-line react/exhaustive-deps, kikoto/no-effect-cancel-flag",
    "/*",
    "  oxlint-disable react-hooks/rules-of-hooks -- copied from elsewhere",
    "*/",
    "// eslint-disable-next-line -- no rule named, so every rule",
    "/* eslint-disable-line exhaustive-deps */",
  ].join("\n");

  assert.deepEqual(lines(source), [2, 3, 4, 5, 6, 9, 10]);
});

test("flags a directive that names only a kikoto effect rule", () => {
  assert.deepEqual(
    lines("// oxlint-disable-next-line kikoto/no-effect-abort-controller"),
    [1],
  );
});

test("leaves directives for other rules and prose that names one", () => {
  const source = [
    "// eslint-disable-next-line no-console -- exhaustive-deps is not named",
    "/* oxlint-disable-line typescript/no-explicit-any */",
    "// See the exhaustive-deps rule; never eslint disable it.",
    "// eslint-enable react-hooks/exhaustive-deps",
    "const name = 'eslint-disabled';",
    "// eslint-disable-line no-restricted-syntax",
    "/* eslint-disable no-alert */ const exhaustiveDeps = true;",
  ].join("\n");

  assert.deepEqual(lines(source), []);
});

test("scans the source tree and names each file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kikoto-hook-deps-"));
  try {
    fs.mkdirSync(path.join(root, "features"));
    fs.writeFileSync(
      path.join(root, "features", "A.tsx"),
      "}, []); // eslint-disable-line\n",
    );
    fs.writeFileSync(path.join(root, "clean.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(root, "notes.md"), "// eslint-disable-line\n");
    const found = scan(root);
    assert.equal(found.length, 1);
    assert.match(found[0].file, /features\/A\.tsx$/u);
    assert.equal(found[0].line, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
