// Keeps production source files from growing past a size where every change
// adds to them instead of to a module of its own.
//
// New code lands in the file the change touches, so a large file keeps
// growing, and a split file grows back. This check fails when a backend Go or
// frontend source file is longer than the limit, unless the baseline records
// it; a recorded file may not grow past its recorded length. The baseline only
// moves down with the code: a file that shrank or dropped under the limit
// fails until `--lower` records it. Split a large file by responsibility
// instead of adding to it, and never raise or add a baseline entry.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const lineLimit = 800;

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const baselinePath =
  process.argv
    .find((argument) => argument.startsWith("--baseline="))
    ?.slice("--baseline=".length) ??
  path.join(repositoryRoot, "scripts", "file-size-baseline.json");

/**
 * Whether `file` (repository-relative, forward slashes) is production source
 * this check measures. Tests, fixtures, and the locale tables are data, not
 * code a change copies from.
 */
export function measured(file) {
  if (file.startsWith("backend/")) {
    return file.endsWith(".go") && !file.endsWith("_test.go");
  }
  if (!file.startsWith("frontend/src/")) return false;
  if (!/\.(?:ts|tsx)$/u.test(file) || /\.test\.tsx?$/u.test(file)) return false;
  return (
    !file.startsWith("frontend/src/i18n/") &&
    !file.startsWith("frontend/src/test-support/")
  );
}

/** The number of lines in `text`, counting a final line without a newline. */
export function lineCount(text) {
  if (text === "") return 0;
  const lines = text.split(/\r?\n/u).length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** The measured files under `root` and their line counts, tracked or not yet ignored. */
export function measure(root) {
  const listed = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "backend",
      "frontend/src",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const sizes = {};
  for (const file of listed.split("\n")) {
    if (!measured(file)) continue;
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    sizes[file] = lineCount(fs.readFileSync(absolute, "utf8"));
  }
  return sizes;
}

/** What the current sizes add to the baseline, and the entries the code has moved below. */
export function compare(sizes, baseline, limit = lineLimit) {
  const failures = [];
  const stale = [];
  for (const [file, lines] of Object.entries(sizes)) {
    const recorded = baseline[file];
    if (recorded === undefined) {
      if (lines > limit)
        failures.push(
          `${file} has ${lines} lines, above the ${limit}-line limit`,
        );
    } else if (lines > recorded) {
      failures.push(
        `${file} grew to ${lines} lines, baseline allows ${recorded}`,
      );
    }
  }
  for (const [file, recorded] of Object.entries(baseline)) {
    const lines = sizes[file];
    if (lines === undefined)
      stale.push(`${file} is gone, baseline allows ${recorded}`);
    else if (lines < recorded)
      stale.push(`${file} has ${lines} lines, baseline allows ${recorded}`);
  }
  return { failures, stale };
}

/** The baseline after the code moved down: recorded files keep the smaller length; files at or under the limit leave. */
export function lowered(sizes, baseline, limit = lineLimit) {
  const next = {};
  for (const [file, recorded] of Object.entries(baseline)) {
    const lines = sizes[file];
    if (lines === undefined || lines <= limit) continue;
    next[file] = Math.min(lines, recorded);
  }
  return next;
}

function write(baseline) {
  const sorted = Object.fromEntries(
    Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)),
  );
  fs.writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const sizes = measure(repositoryRoot);
  if (!fs.existsSync(baselinePath)) {
    console.error(
      "scripts/file-size-baseline.json is missing. Restore it from git; the baseline is never recorded from scratch.",
    );
    process.exit(1);
  }
  let baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if (process.argv.includes("--lower")) {
    const previous = Object.keys(baseline).length;
    baseline = lowered(sizes, baseline);
    write(baseline);
    console.log(
      `Recorded ${Object.keys(baseline).length} files above ${lineLimit} lines (was ${previous}).`,
    );
  }
  const { failures, stale } = compare(sizes, baseline);
  if (failures.length > 0) {
    console.error(
      `Found ${failures.length} file${failures.length === 1 ? "" : "s"} over the size budget.`,
    );
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(
      `Split the file by responsibility, or put the new code in a module of its own. Never raise or add an entry in scripts/file-size-baseline.json.`,
    );
    process.exitCode = 1;
  }
  if (stale.length > 0) {
    console.error(
      `Found ${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} above the current size.`,
    );
    for (const entry of stale) console.error(`- ${entry}`);
    console.error(
      "Record the smaller sizes with make file-size-ratchet-lower and commit the baseline.",
    );
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) {
    console.log(
      `Checked ${Object.keys(sizes).length} source files; ${Object.keys(baseline).length} recorded above ${lineLimit} lines.`,
    );
  }
}
