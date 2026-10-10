import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const historySize = 20;

const seconds = (start, end) => {
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export function summarizeRun(run, jobs) {
  const active = jobs.filter((job) => job.conclusion !== "skipped");
  const measured = active
    .map((job) => ({
      name: job.name,
      result: job.conclusion,
      seconds: seconds(job.started_at, job.completed_at),
      steps: (job.steps ?? [])
        .filter((step) => step.conclusion !== "skipped")
        .map((step) => ({
          name: step.name,
          result: step.conclusion,
          seconds: seconds(step.started_at, step.completed_at),
        })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const complete =
    measured.length > 0 && measured.every((job) => job.seconds !== null);
  const firstStart = complete
    ? new Date(
        Math.min(...active.map((job) => Date.parse(job.started_at))),
      ).toISOString()
    : null;
  const lastEnd = complete
    ? new Date(
        Math.max(...active.map((job) => Date.parse(job.completed_at))),
      ).toISOString()
    : null;
  // A rerun keeps the creation time of the first attempt, so queue and total
  // elapsed time are only meaningful for attempt 1.
  const first = run.run_attempt === 1 && complete;
  return {
    id: run.id,
    attempt: run.run_attempt,
    sha: run.head_sha,
    url: run.html_url,
    event: run.event,
    conclusion: run.conclusion,
    queueSeconds: first ? seconds(run.created_at, firstStart) : null,
    executionSeconds: complete ? seconds(firstStart, lastEnd) : null,
    elapsedSeconds: first ? seconds(run.created_at, lastEnd) : null,
    runnerSeconds: complete
      ? measured.reduce((sum, job) => sum + job.seconds, 0)
      : null,
    // The executed job set is the CI plan, so only runs that selected the
    // same validation are compared.
    comparisonKey: complete
      ? JSON.stringify([run.event, measured.map((job) => job.name)])
      : null,
    jobs: measured,
  };
}

const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ??
  null;

export function compareRuns(current, history) {
  const comparable = history.filter(
    (run) =>
      current.comparisonKey &&
      run.comparisonKey === current.comparisonKey &&
      run.conclusion === "success" &&
      run.id !== current.id,
  );
  const execution = comparable.map((run) => run.executionSeconds);
  return {
    samples: comparable.length,
    executionP50: percentile(execution, 0.5),
    executionP90: percentile(execution, 0.9),
    runnerP50: percentile(
      comparable.map((run) => run.runnerSeconds),
      0.5,
    ),
    jobP50: Object.fromEntries(
      current.jobs.map((job) => [
        job.name,
        percentile(
          comparable.flatMap((run) =>
            run.jobs
              .filter((other) => other.name === job.name)
              .map((other) => other.seconds),
          ),
          0.5,
        ),
      ]),
    ),
    runIds: comparable.map((run) => run.id),
  };
}

export function renderReport(current, baseline) {
  const duration = (value) =>
    value === null || value === undefined
      ? "Unavailable"
      : `${value.toFixed(1)} s`;
  // Job names come from the measured workflow, which a pull request controls.
  const escape = (value) =>
    String(value)
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ")
      .replaceAll("<", "&lt;");
  return [
    "# CI performance observation",
    "",
    `Run ${current.id}, attempt ${current.attempt}; result: ${escape(current.conclusion)}.`,
    "",
    "| Metric | Current | Comparable baseline |",
    "| --- | ---: | ---: |",
    `| Initial queue | ${duration(current.queueSeconds)} | n/a |`,
    `| Execution wall time | ${duration(current.executionSeconds)} | P50 ${duration(baseline.executionP50)} / P90 ${duration(baseline.executionP90)} |`,
    `| Total elapsed | ${duration(current.elapsedSeconds)} | n/a |`,
    `| Sum of runner time | ${duration(current.runnerSeconds)} | P50 ${duration(baseline.runnerP50)} |`,
    "",
    `Baseline: ${baseline.samples} earlier successful runs of the same event that executed the same jobs. Cache state is not part of the comparison.`,
    "No threshold blocks CI. Runner time is elapsed job time, not billed minutes. Queue and total elapsed are unavailable for reruns.",
    "",
    "| Job | Result | Duration | Baseline P50 |",
    "| --- | --- | ---: | ---: |",
    ...current.jobs.map(
      (job) =>
        `| ${escape(job.name)} | ${escape(job.result)} | ${duration(job.seconds)} | ${duration(baseline.jobP50[job.name])} |`,
    ),
    "",
    "The JSON artifact holds per-step durations and the baseline run IDs.",
    "",
  ].join("\n");
}

function main() {
  if (!process.env.GITHUB_EVENT_PATH)
    throw new Error("GITHUB_EVENT_PATH must point to a workflow_run event.");
  const run = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
  ).workflow_run;
  if (!run) throw new Error("Event must contain a workflow_run.");
  const repository = process.env.GITHUB_REPOSITORY;
  const api = (path, paginate = false) =>
    JSON.parse(
      execFileSync(
        "gh",
        ["api", ...(paginate ? ["--paginate", "--slurp"] : []), path],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    );
  const summarize = (item) =>
    summarizeRun(
      item,
      api(
        `repos/${repository}/actions/runs/${item.id}/attempts/${item.run_attempt}/jobs?per_page=100`,
        true,
      ).flatMap((page) => page.jobs),
    );

  const current = summarize(run);
  const history = [];
  if (current.comparisonKey) {
    const candidates = api(
      `repos/${repository}/actions/workflows/${run.workflow_id}/runs?status=success&event=${encodeURIComponent(run.event)}&per_page=${historySize}`,
    ).workflow_runs;
    for (const candidate of candidates) {
      if (
        candidate.id !== run.id &&
        Date.parse(candidate.created_at) < Date.parse(run.created_at)
      )
        history.push(summarize(candidate));
    }
  }
  const baseline = compareRuns(current, history);
  const report = renderReport(current, baseline);

  const directory = join(process.env.RUNNER_TEMP || ".", "ci-metrics");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify({ version: 1, current, baseline }, null, 2),
  );
  writeFileSync(join(directory, "report.md"), report);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  console.log(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
