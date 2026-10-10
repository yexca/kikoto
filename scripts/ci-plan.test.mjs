import assert from "node:assert/strict";
import test from "node:test";
import { createPlan, planKeys, validateResults } from "./ci-plan.mjs";

const pr = (paths) =>
  createPlan({ eventName: "pull_request", ref: "refs/pull/1/merge", paths });
const jobs = {
  backend: "backend",
  frontend: "frontend",
  "full-e2e": "e2e",
  android: "android",
  ios: "ios",
  smoke: "production",
  "dev-smoke": "dev_smoke",
};
// The jobs a pull request must pass to merge; the rest only gate a release.
const coreJobs = ["backend", "frontend"];
const resultsFor = (plan) => ({
  style: { result: "success" },
  ...Object.fromEntries(
    Object.entries(jobs).map(([job, key]) => [
      job,
      { result: plan[key] ? "success" : "skipped" },
    ]),
  ),
});

test("documentation-only PRs skip expensive jobs while unknown paths require full validation", () => {
  assert.ok(
    Object.values(
      pr([
        "docs/development/testing.md",
        "docs/readme/README.zh-Hans.md",
        "docs/development/design.md",
      ]),
    ).every((value) => value === false),
  );
  for (const paths of [
    null,
    [],
    ["new-runtime/settings.json"],
    ["VERSION"],
    ["Makefile"],
    [".github/workflows/ci.yml"],
    ["scripts/ci-plan.mjs"],
    ["frontend/package-lock.json"],
    ["backend/go.sum"],
  ]) {
    assert.ok(Object.values(pr(paths)).every(Boolean), String(paths));
  }
});

test("PR plans include cross-platform consumers and the union of renamed/deleted paths", () => {
  assert.deepEqual(pr(["frontend/src/player/PlayerProvider.tsx"]), {
    backend: false,
    frontend: true,
    e2e: true,
    android: true,
    ios: false,
    production: true,
    dev_smoke: false,
  });
  assert.deepEqual(pr(["backend/internal/httpapi/server.go"]), {
    backend: true,
    frontend: false,
    e2e: true,
    android: false,
    ios: false,
    production: true,
    dev_smoke: false,
  });
  assert.deepEqual(pr(["frontend/android/app/build.gradle"]), {
    backend: false,
    frontend: false,
    e2e: false,
    android: true,
    ios: false,
    production: false,
    dev_smoke: false,
  });
  assert.deepEqual(pr(["frontend/ios/App/App/Info.plist"]), {
    backend: false,
    frontend: false,
    e2e: false,
    android: false,
    ios: true,
    production: false,
    dev_smoke: false,
  });
  const capacitor = pr(["frontend/capacitor.config.ts"]);
  assert.equal(capacitor.android, true);
  assert.equal(capacitor.ios, true);
  assert.equal(pr(["docker-compose.dev.yml"]).dev_smoke, true);
  assert.deepEqual(pr(["deploy/compose/dev.yml"]), {
    backend: false,
    frontend: false,
    e2e: false,
    android: false,
    ios: false,
    production: false,
    dev_smoke: true,
  });
  assert.equal(pr(["frontend/tests/e2e/player.spec.ts"]).e2e, true);
  assert.equal(pr(["frontend/tests/future-unit.test.ts"]).frontend, true);
  const renamed = pr(["backend/internal/old.go", "docs/retired.md"]);
  assert.equal(renamed.backend, true);
  assert.equal(renamed.production, true);
});

test("main always runs every job and reusable calls preserve the build opt-in", () => {
  for (const eventName of ["push", "workflow_dispatch", "workflow_call"]) {
    assert.ok(
      Object.values(
        createPlan({ eventName, ref: "refs/heads/main", paths: ["README.md"] }),
      ).every(Boolean),
    );
  }
  assert.ok(
    Object.values(
      createPlan({
        eventName: "workflow_call",
        ref: "refs/tags/example",
        runBuilds: true,
      }),
    ).every(Boolean),
  );
  const called = createPlan({
    eventName: "workflow_call",
    ref: "refs/tags/example",
  });
  assert.equal(called.backend, true);
  assert.equal(called.dev_smoke, true);
  assert.equal(called.production, false);
  assert.equal(called.android, false);
  assert.equal(called.ios, false);
});

test("each gate accepts only planned skips and rejects failures, cancellations and missing results of its own jobs", () => {
  for (const plan of [
    pr(["README.md"]),
    pr(["VERSION"]),
    pr(["frontend/src/app.tsx"]),
  ]) {
    for (const gate of ["core", "complete"]) {
      assert.doesNotThrow(() => validateResults(plan, resultsFor(plan), gate));
      for (const job of ["style", ...Object.keys(jobs)]) {
        const gated =
          job === "style" || gate === "complete" || coreJobs.includes(job);
        const verdict = gated ? assert.throws : assert.doesNotThrow;
        for (const result of ["failure", "cancelled", undefined]) {
          const results = resultsFor(plan);
          results[job] = { result };
          verdict(() => validateResults(plan, results, gate), `${gate} ${job}`);
        }
        if (job === "style" || plan[jobs[job]]) {
          const results = resultsFor(plan);
          results[job] = { result: "skipped" };
          verdict(() => validateResults(plan, results, gate), `${gate} ${job}`);
        }
      }
    }
    assert.throws(() => validateResults(plan, resultsFor(plan), "optional"));
  }
  for (const plan of [
    null,
    {},
    Object.fromEntries(planKeys.map((key) => [key, "false"])),
  ]) {
    assert.throws(() => validateResults(plan, {}));
  }
});
