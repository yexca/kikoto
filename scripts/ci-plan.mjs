import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Validation runs in one of two tiers. `pr` selects jobs from the changed
// paths and is what a pull request must pass to merge. `full` runs every job
// and is what a release must pass to publish.
export const tiers = ["pr", "full"];

// Every planned validation job and the plan key that selects it. The Gate
// evaluates all of them in both tiers.
export const jobs = {
  backend: "backend",
  frontend: "frontend",
  e2e: "e2e",
  android: "android",
  ios: "ios",
  smoke: "production",
  "dev-smoke": "dev_smoke",
};

export const planKeys = Object.values(jobs);

export function createPlan({ tier, paths = null }) {
  if (!tiers.includes(tier)) throw new Error(`Unknown CI tier: ${tier}`);
  const full = Object.fromEntries(planKeys.map((key) => [key, true]));
  // A missing/empty diff is not evidence that it is safe to skip validation.
  if (tier === "full" || !paths?.length) return full;
  const plan = Object.fromEntries(planKeys.map((key) => [key, false]));
  for (const path of paths) {
    if (
      path.startsWith("docs/") ||
      /^(README(?:\.[\w-]+)?\.md|AGENTS\.md|CONTRIBUTING\.md|DESIGN\.md|SECURITY\.md|PRIVACY\.md|LICENSE)$/.test(
        path,
      )
    )
      continue;
    if (
      /^(Makefile|VERSION|\.github\/|scripts\/|backend\/go\.(mod|sum)$|frontend\/package(?:-lock)?\.json$)/.test(
        path,
      )
    )
      return full;
    if (path.startsWith("frontend/android/")) {
      plan.android = true;
    } else if (path.startsWith("frontend/ios/")) {
      plan.ios = true;
    } else if (
      path === "frontend/Dockerfile" ||
      path === "backend/Dockerfile" ||
      path === "frontend/nginx.conf" ||
      path === "docker-compose.dev.yml" ||
      path === "deploy/compose/dev.yml"
    ) {
      plan.dev_smoke = true;
    } else if (path.startsWith("frontend/tests/e2e/")) {
      plan.e2e = true;
    } else if (path.startsWith("frontend/")) {
      // Outside their own projects, only Capacitor configuration changes the
      // native builds; the web bundle they embed is validated by the web jobs.
      if (path === "frontend/capacitor.config.ts")
        Object.assign(plan, { android: true, ios: true });
      Object.assign(plan, { frontend: true, e2e: true, production: true });
    } else if (path.startsWith("backend/")) {
      Object.assign(plan, { backend: true, e2e: true, production: true });
    } else {
      return full;
    }
  }
  return plan;
}

export function validateResults(plan, results) {
  if (!plan || planKeys.some((key) => typeof plan[key] !== "boolean"))
    throw new Error("Missing or invalid CI plan");
  if (results.style?.result !== "success")
    throw new Error("Style and CI planning must succeed");
  for (const [job, key] of Object.entries(jobs)) {
    const result = results[job]?.result;
    if (
      result !== "success" &&
      !(plan[key] === false && result === "skipped")
    ) {
      throw new Error(
        `CI job ${job} did not satisfy its plan: ${result ?? "missing"}`,
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "check") {
    validateResults(
      JSON.parse(process.env.CI_PLAN || "null"),
      JSON.parse(process.env.CI_RESULTS || "{}"),
    );
    console.log("Every planned job succeeded.");
  } else if (process.argv[2] === "plan") {
    const tier = process.env.CI_TIER;
    let paths = null;
    if (tier === "pr" && /^[a-f0-9]{40}$/.test(process.env.CI_BASE_SHA || "")) {
      const diff = spawnSync(
        "git",
        [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          process.env.CI_BASE_SHA,
          "HEAD",
        ],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (diff.status === 0) paths = diff.stdout.split("\0").filter(Boolean);
    }
    const plan = createPlan({ tier, paths });
    const outputs =
      [
        `plan=${JSON.stringify(plan)}`,
        ...planKeys.map((key) => `${key}=${plan[key]}`),
      ].join("\n") + "\n";
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, outputs);
    console.log(outputs.trim());
  } else {
    throw new Error("usage: node scripts/ci-plan.mjs <plan|check>");
  }
}
