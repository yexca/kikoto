import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPullRequestDescription } from "./check-pr-description.mjs";

const template = readFileSync(
  new URL("../.github/pull_request_template.md", import.meta.url),
  "utf8",
);
const filled = template
  .replace(
    "<!-- /kikoto:change -->",
    "扫描会保留离线存储池的已知状态。\n<!-- /kikoto:change -->",
  )
  .replace(
    "<!-- /kikoto:validation -->",
    "- [x] `make ci-backend` passed.\n<!-- /kikoto:validation -->",
  )
  .replace("<!-- /kikoto:upgrade -->", "None.\n<!-- /kikoto:upgrade -->");
const check = (body, extra = {}) =>
  checkPullRequestDescription({ body, draft: false, ...extra });

test("an untouched template or missing body cannot pass the description gate", () => {
  assert.equal(check(template).errors.length, 3);
  assert.equal(check(null).errors.length, 3);
});

test("contributors can rename headings, use another language, and list Makefile results", () => {
  assert.deepEqual(check(filled.replaceAll("## ", "### ")).errors, []);
});

test("validation and upgrade impact must be filled even when the change is described", () => {
  const partial = template.replace(
    "<!-- /kikoto:change -->",
    "Fix scan scope.\n<!-- /kikoto:change -->",
  );
  assert.equal(check(partial).errors.length, 2);
});

test("comments, headings, and empty checkboxes are not a change explanation", () => {
  const scaffolding = filled.replace(
    "扫描会保留离线存储池的已知状态。",
    "<!-- instruction -->\n## Change\n- [ ]\n- [x]\n...",
  );
  assert.equal(check(scaffolding).errors.length, 1);
});

test("removing a section marker produces an actionable failure", () => {
  const result = check(filled.replace("<!-- /kikoto:validation -->", ""));
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Validation.*kikoto:validation/u);
});

test("drafts and genuine Dependabot updates are exempt, other authors are checked", () => {
  assert.ok(check(null, { draft: true }).skipped);
  assert.ok(
    check(null, { user: { login: "dependabot[bot]", type: "Bot" } }).skipped,
  );
  assert.equal(
    check(null, { user: { login: "example-bot", type: "Bot" } }).errors.length,
    3,
  );
});

test("the command fails incomplete metadata without echoing the PR body into logs", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "kikoto-pr-description-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventFile = path.join(directory, "event.json");
  const summaryFile = path.join(directory, "summary.md");
  writeFileSync(
    eventFile,
    JSON.stringify({
      pull_request: { body: "synthetic-report-body", draft: false },
    }),
  );
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./check-pr-description.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /PR description is incomplete/u);
  assert.doesNotMatch(
    result.stdout + result.stderr + readFileSync(summaryFile, "utf8"),
    /synthetic-report-body/u,
  );
});
