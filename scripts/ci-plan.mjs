import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const planKeys = [
  "backend",
  "frontend",
  "e2e",
  "android",
  "production",
  "dev_smoke",
];

export function createPlan({
  eventName,
  ref,
  runBuilds = false,
  paths = null,
}) {
  const full = Object.fromEntries(planKeys.map((key) => [key, true]));
  if (ref === "refs/heads/main" || runBuilds) return full;
  if (eventName !== "pull_request")
    return { ...full, android: false, production: false };
  // A missing/empty diff is not evidence that it is safe to skip validation.
  if (!paths?.length) return full;
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
    } else if (
      path === "frontend/Dockerfile" ||
      path === "backend/Dockerfile" ||
      path === "frontend/nginx.conf" ||
      path === "docker-compose.dev.yml"
    ) {
      plan.dev_smoke = true;
    } else if (path.startsWith("frontend/tests/e2e/")) {
      plan.e2e = true;
    } else if (path.startsWith("frontend/")) {
      Object.assign(plan, {
        frontend: true,
        e2e: true,
        android: true,
        production: true,
      });
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
  for (const [job, key] of Object.entries({
    backend: "backend",
    frontend: "frontend",
    "full-e2e": "e2e",
    android: "android",
    smoke: "production",
    "dev-smoke": "dev_smoke",
  })) {
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
    console.log("All planned CI jobs succeeded.");
  } else if (process.argv[2] === "plan") {
    let paths = null;
    if (
      process.env.GITHUB_EVENT_NAME === "pull_request" &&
      /^[a-f0-9]{40}$/.test(process.env.CI_BASE_SHA || "")
    ) {
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
    const plan = createPlan({
      eventName: process.env.GITHUB_EVENT_NAME,
      ref: process.env.GITHUB_REF,
      runBuilds: process.env.CI_RUN_BUILDS === "true",
      paths,
    });
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
