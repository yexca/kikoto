import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { candidates } from "./check-ui-copy.mjs";

test("does not treat TypeScript arrow functions and generics as UI copy", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kikoto-ui-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "fixture.tsx");
  fs.writeFileSync(
    file,
    [
      "const latest = runs.reduce<Run | null>((current, run) => run, null);",
      "const label = <span>Recent runs</span>;",
    ].join("\n"),
  );

  assert.deepEqual(
    Object.values(candidates(file)).map((values) => [...values]),
    [["text: Recent runs"]],
  );
});
