import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const sections = [
  ["change", "Change"],
  ["validation", "Validation"],
  ["upgrade", "Upgrade impact"],
];

export function checkPullRequestDescription(pullRequest) {
  if (pullRequest.draft) return { skipped: "Draft pull request", errors: [] };
  if (
    pullRequest.user?.type === "Bot" &&
    pullRequest.user.login === "dependabot[bot]"
  )
    return { skipped: "Dependabot dependency update", errors: [] };

  const body = pullRequest.body || "";
  const errors = [];
  for (const [id, label] of sections) {
    const section = body.match(
      new RegExp(
        `<!--\\s*kikoto:${id}\\s*-->([\\s\\S]*?)<!--\\s*/kikoto:${id}\\s*-->`,
        "u",
      ),
    );
    const content = (section?.[1] || "")
      .replace(/<!--[\s\S]*?-->/gu, "")
      .replace(/^\s{0,3}#{1,6}[ \t].*$/gmu, "")
      .replace(/^\s*[-*+]\s*\[[ xX]\]\s*$/gmu, "")
      .trim();
    if (!/[\p{L}\p{N}]/u.test(content))
      errors.push(
        `Fill in ${label} between its kikoto:${id} markers. Keep both markers from the PR template.`,
      );
  }
  return { skipped: null, errors };
}

function main() {
  if (!process.env.GITHUB_EVENT_PATH)
    throw new Error(
      "GITHUB_EVENT_PATH must point to a pull request event JSON.",
    );
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (!event.pull_request)
    throw new Error("Event must contain a pull_request.");
  const result = checkPullRequestDescription(event.pull_request);
  const message = result.skipped
    ? `PR description check skipped: ${result.skipped}.`
    : result.errors.length
      ? [
          "PR description is incomplete:",
          ...result.errors.map((e) => `- ${e}`),
        ].join("\n")
      : "PR description check passed.";
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  if (result.errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
