import assert from "node:assert/strict";
import test from "node:test";
import { createPlan, jobs, planKeys, validateResults } from "./ci-plan.mjs";

const pr = (paths) => createPlan({ tier: "pr", paths });
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
    [".github/workflows/validate.yml"],
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
    android: false,
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
  assert.deepEqual(pr(["frontend/capacitor.config.ts"]), {
    backend: false,
    frontend: true,
    e2e: true,
    android: true,
    ios: true,
    production: true,
    dev_smoke: false,
  });
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

test("the full tier runs every job whatever changed, and an unknown tier is rejected", () => {
  for (const paths of [null, [], ["README.md"], ["docs/overview.md"]]) {
    assert.ok(
      Object.values(createPlan({ tier: "full", paths })).every(Boolean),
      String(paths),
    );
  }
  for (const tier of [undefined, "", "complete", "PR"]) {
    assert.throws(() => createPlan({ tier, paths: ["README.md"] }));
  }
});

test("the gate accepts only planned skips and rejects failures, cancellations and missing results", () => {
  for (const plan of [
    pr(["README.md"]),
    pr(["VERSION"]),
    pr(["frontend/src/app.tsx"]),
    createPlan({ tier: "full" }),
  ]) {
    assert.doesNotThrow(() => validateResults(plan, resultsFor(plan)));
    for (const job of ["style", ...Object.keys(jobs)]) {
      for (const result of ["failure", "cancelled", undefined]) {
        const results = resultsFor(plan);
        results[job] = { result };
        assert.throws(() => validateResults(plan, results), job);
      }
      if (job === "style" || plan[jobs[job]]) {
        const results = resultsFor(plan);
        results[job] = { result: "skipped" };
        assert.throws(() => validateResults(plan, results), job);
      }
    }
  }
  for (const plan of [
    null,
    {},
    Object.fromEntries(planKeys.map((key) => [key, "false"])),
  ]) {
    assert.throws(() => validateResults(plan, {}));
  }
});
