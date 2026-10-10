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

// The scripts under scripts/ and the planned jobs that run them. Style always
// runs, and it formats and tests every script, so one that only Style or no
// job uses selects nothing. An unlisted script selects every job.
export const scriptJobs = {
  "check-go-format.go": ["backend"],
  "golangci-lint.yml": ["backend"],
  "go-test-shard.mjs": ["backend"],
  "production-smoke.mjs": ["production"],
  "production-browser-smoke.mjs": ["production"],
  "smoke.mjs": ["dev_smoke"],
  "check-doc-links.mjs": [],
  "check-doc-locales.mjs": [],
  "check-pr-description.mjs": [],
  "check-sensitive.mjs": [],
  "check-ui-copy.mjs": [],
  "ci-metrics.mjs": [],
  "privacy-allowlist.json": [],
  "ui-copy-baseline.json": [],
  "run-browse-performance.mjs": [],
  "run-recommendation-performance.mjs": [],
  "test-kikoto-helper.ps1": [],
};

const documentation =
  /^(docs\/|(README(?:\.[\w-]+)?\.md|AGENTS\.md|CONTRIBUTING\.md|DESIGN\.md|SECURITY\.md|PRIVACY\.md|LICENSE)$)/;
// Both development images are built from these.
const devImage =
  /^(frontend\/Dockerfile|backend\/Dockerfile|frontend\/nginx(?:-security)?\.conf|docker-compose\.dev\.yml|deploy\/compose\/dev\.yml)$/;

// The plan keys a changed path selects, or null when it selects every job.
function jobsFor(path) {
  if (documentation.test(path)) return [];
  if (/^(Makefile|VERSION)$/.test(path) || path.startsWith(".github/"))
    return null;
  if (path.startsWith("scripts/")) {
    const name = path.slice("scripts/".length);
    if (/^[^/]+\.test\.mjs$/.test(name)) return [];
    return Object.hasOwn(scriptJobs, name) ? scriptJobs[name] : null;
  }
  // A dependency manifest reaches every job that installs from it and no
  // other: the browser suite intercepts the API and never starts the backend.
  if (/^backend\/go\.(mod|sum)$/.test(path))
    return ["backend", "production", "dev_smoke"];
  if (/^frontend\/(package(?:-lock)?\.json|\.npmrc)$/.test(path))
    return ["frontend", "e2e", "production", "android", "ios", "dev_smoke"];
  if (path === "Dockerfile") return ["production"];
  if (path === ".dockerignore") return ["production", "dev_smoke"];
  if (path.startsWith("frontend/android/")) return ["android"];
  if (path.startsWith("frontend/ios/")) return ["ios"];
  if (devImage.test(path)) return ["dev_smoke"];
  if (path.startsWith("frontend/tests/e2e/")) return ["e2e"];
  // Outside their own projects, only Capacitor configuration changes the
  // native builds; the web bundle they embed is validated by the web jobs.
  if (path === "frontend/capacitor.config.ts")
    return ["frontend", "e2e", "production", "android", "ios"];
  if (path.startsWith("frontend/")) return ["frontend", "e2e", "production"];
  if (path.startsWith("backend/")) return ["backend", "production"];
  return null;
}

export function createPlan({ tier, paths = null }) {
  if (!tiers.includes(tier)) throw new Error(`Unknown CI tier: ${tier}`);
  const full = Object.fromEntries(planKeys.map((key) => [key, true]));
  // A missing/empty diff is not evidence that it is safe to skip validation.
  if (tier === "full" || !paths?.length) return full;
  const plan = Object.fromEntries(planKeys.map((key) => [key, false]));
  for (const path of paths) {
    const selected = jobsFor(path);
    if (!selected) return full;
    for (const key of selected) plan[key] = true;
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
