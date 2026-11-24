import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ruleCode = "kikoto-workflow-links(no-handwritten-address)";

// Runs Oxlint with only this rule on the fixture and returns the lines it reports.
function reportedLines(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kikoto-workflow-links-"));
  try {
    const config = path.join(dir, "oxlintrc.json");
    fs.writeFileSync(
      config,
      JSON.stringify({
        categories: { correctness: "off" },
        jsPlugins: [path.join(here, "oxlint-workflow-links.mjs")],
        rules: { "kikoto-workflow-links/no-handwritten-address": "error" },
      }),
    );
    const fixture = path.join(dir, "fixture.ts");
    fs.writeFileSync(fixture, `${lines.join("\n")}\n`);
    const run = spawnSync(
      process.execPath,
      [path.join(here, "node_modules", "oxlint", "bin", "oxlint"), "-c", config, "-f", "json", fixture],
      { encoding: "utf8" },
    );
    const { diagnostics } = JSON.parse(run.stdout);
    return [...new Set(diagnostics.filter((item) => item.code === ruleCode).map((item) => item.labels[0].span.line))];
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("reports an address of Workflows written outside lib/workflowLinks and nothing else", () => {
  const flagged = [
    'window.history.pushState({}, "", `/workflows?run=${runId}`);',
    'window.history.pushState({}, "", workflowRunPath(runId));',
    "window.history.replaceState({}, '', `${WORKFLOWS_PATH}?run=${runId}`);",
    'const list = "/workflows";',
    "const link = `${origin}/workflows?tab=history`;",
  ];
  const allowed = [
    'window.history.pushState({}, "", href);',
    'const discover = "/discover?panel=subscriptions";',
    "const run = workflowRunPath(runId);",
    'const other = "/workflowsish";',
  ];
  const lines = [...flagged, ...allowed];

  assert.deepEqual(
    reportedLines(lines),
    flagged.map((_, index) => index + 1),
  );
});
