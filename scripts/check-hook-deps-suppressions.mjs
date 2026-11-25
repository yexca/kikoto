import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Keeps the hook and effect rules on in frontend/src. A lint rule cannot do
// this: a blanket `eslint-disable-line`, a file-wide `eslint-disable`, or a
// directive that names the guarding rule too silences the report about itself.
// So this reads the raw source instead, and a directive cannot reach it.
// docs/development/frontend-guidelines.md#async-effects says what to use.

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const sourceRoot = path.join(repositoryRoot, "frontend", "src");

// Every comment that Oxlint or ESLint reads as a disable directive opens with
// one of these, whitespace and line breaks allowed between. A string that
// merely quotes a directive matches too; reword it rather than escape it.
const directive =
  /(\/\/|\/\*\*?)\s*((?:eslint|oxlint)-disable(?:-next-line|-line)?)(?![\w-])/gu;

// Rule names whose suppression this check refuses, whatever plugin prefix the
// directive spells them with.
const guardedRule =
  /(?:^|[\s,/])(?:exhaustive-deps|rules-of-hooks)(?![\w-])|(?:^|[\s,])kikoto(?:-[\w-]+)?\//u;

const message =
  "Keep hook dependency lists complete and the effect rules on. Read a value that must not re-run the effect through useStableCallback or a ref instead of disabling a rule";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return /\.(?:[cm]?[jt]sx?)$/u.test(entry.name) ? [absolute] : [];
  });
}

function lineOf(source, index) {
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1 && at < index;) {
    line += 1;
    at = source.indexOf("\n", at + 1);
  }
  return line;
}

/** The rules a directive names, before any `--` description; "" for all. */
function namedRules(source, match) {
  const start = match.index + match[0].length;
  const lineEnd = source.indexOf("\n", start);
  let end = lineEnd === -1 ? source.length : lineEnd;
  if (match[1] !== "//") {
    const close = source.indexOf("*/", start);
    if (close !== -1) end = close;
  }
  return source.slice(start, end).split("--")[0].trim();
}

/** Every directive in a source that disables all rules or a guarded one. */
export function violations(source) {
  const found = [];
  for (const match of source.matchAll(directive)) {
    const rules = namedRules(source, match);
    if (rules !== "" && !guardedRule.test(rules)) continue;
    found.push({
      line: lineOf(source, match.index),
      directive: rules === "" ? match[2] : `${match[2]} ${rules}`,
    });
  }
  return found;
}

export function scan(root) {
  return walk(root).flatMap((file) =>
    violations(fs.readFileSync(file, "utf8")).map((violation) => ({
      file: path.relative(repositoryRoot, file).replaceAll("\\", "/"),
      ...violation,
    })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scan(sourceRoot);
  if (found.length > 0) {
    console.error(
      `Found ${found.length} directive${found.length === 1 ? "" : "s"} in frontend/src that switch${found.length === 1 ? "es" : ""} off every rule or a hook or effect rule.`,
    );
    for (const { file, line, directive: text } of found)
      console.error(`- ${file}:${line}: ${text}`);
    console.error(
      `${message} (docs/development/frontend-guidelines.md#async-effects).`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "Checked frontend/src for directives that switch off the hook and effect rules.",
    );
  }
}
