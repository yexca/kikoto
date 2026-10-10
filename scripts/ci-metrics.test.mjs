import assert from "node:assert/strict";
import test from "node:test";
import { compareRuns, renderReport, summarizeRun } from "./ci-metrics.mjs";

const at = (second) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toJSON();
const job = (name, start, end, conclusion = "success") => ({
  name,
  conclusion,
  started_at: at(start),
  completed_at: at(end),
  steps: [
    {
      name: "Checkout",
      conclusion: "success",
      started_at: at(start),
      completed_at: at(start + 1),
    },
    {
      name: "Upload",
      conclusion: "skipped",
      started_at: at(end),
      completed_at: at(end),
    },
  ],
});
const run = (id, jobs, overrides = {}) =>
  summarizeRun(
    {
      id,
      run_attempt: 1,
      head_sha: "0".repeat(40),
      html_url: `https://github.example/runs/${id}`,
      event: "push",
      conclusion: "success",
      created_at: at(0),
      ...overrides,
    },
    jobs,
  );

test("a run is measured from its executed jobs and skipped work is ignored", () => {
  const summary = run(1, [
    job("Style", 5, 25),
    job("Frontend", 30, 90),
    job("Android build", 30, 30, "skipped"),
  ]);
  assert.deepEqual(
    summary.jobs.map(({ name, seconds }) => [name, seconds]),
    [
      ["Frontend", 60],
      ["Style", 20],
    ],
  );
  assert.deepEqual(
    summary.jobs[0].steps.map((step) => step.name),
    ["Checkout"],
  );
  assert.equal(summary.queueSeconds, 5);
  assert.equal(summary.executionSeconds, 85);
  assert.equal(summary.elapsedSeconds, 90);
  assert.equal(summary.runnerSeconds, 80);

  const rerun = run(1, [job("Style", 5, 25)], { run_attempt: 2 });
  assert.equal(rerun.queueSeconds, null);
  assert.equal(rerun.elapsedSeconds, null);
  assert.equal(rerun.executionSeconds, 20);

  const unfinished = run(1, [{ ...job("Style", 5, 25), completed_at: null }]);
  assert.equal(unfinished.executionSeconds, null);
  assert.equal(unfinished.comparisonKey, null);
});

test("the baseline uses only earlier successful runs that executed the same jobs", () => {
  const jobs = (frontend) => [
    job("Style", 0, 20),
    job("Frontend", 20, 20 + frontend),
  ];
  const current = run(10, jobs(100));
  const baseline = compareRuns(current, [
    run(1, jobs(40)),
    run(2, jobs(60)),
    run(3, jobs(80)),
    run(4, jobs(500), { conclusion: "failure" }),
    run(5, jobs(500), { event: "pull_request" }),
    run(6, [job("Style", 0, 20)]),
    current,
  ]);
  assert.deepEqual(baseline.runIds, [1, 2, 3]);
  assert.equal(baseline.executionP50, 80);
  assert.equal(baseline.executionP90, 100);
  assert.deepEqual(baseline.jobP50, { Frontend: 60, Style: 20 });

  const empty = compareRuns(current, []);
  assert.equal(empty.samples, 0);
  assert.equal(empty.executionP50, null);
  assert.match(renderReport(current, empty), /P50 Unavailable/);
});

test("the report cannot be restructured by a job name", () => {
  const current = run(1, [job("Style | <b>x</b>\nnext", 0, 20)]);
  const report = renderReport(current, compareRuns(current, []));
  assert.ok(report.includes("| Style \\| &lt;b>x&lt;/b> next | success |"));
});
