// Keeps small helpers from being redefined per package or per file.
//
// New code copies whichever helper sits nearby, so a helper that already
// exists elsewhere under the same name keeps multiplying. This check reports
// the Go and TypeScript helpers whose name a second package or file defines
// again, against a baseline of the duplicates that exist today. Reuse the
// shared helper, move it to a shared home, or rename it for what makes it
// differ; record an exception in the baseline only after review.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const baselinePath =
  process.argv
    .find((argument) => argument.startsWith("--baseline="))
    ?.slice("--baseline=".length) ??
  path.join(repositoryRoot, "scripts", "duplicate-helpers-baseline.json");

// The built-in min and max, which every Go helper of these names redefines.
const goBuiltinLookalike =
  /^(?:min|max)(?:Int(?:8|16|32|64)?|Uint(?:8|16|32|64)?|Float(?:32|64))?$/u;

function walk(directory, accept) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", ".git", "dist", "vendor"].includes(entry.name))
      return [];
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute, accept);
    return accept(entry.name) ? [absolute] : [];
  });
}

function relativePath(root, file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function addLocation(names, name, location) {
  if (!names.has(name)) names.set(name, new Set());
  names.get(name).add(location);
}

/**
 * The unexported Go functions by name, and the package directories that define
 * each. Per-platform files of one package share a directory, so a build-tag
 * variant is not a duplicate.
 */
export function goHelpers(root) {
  const names = new Map();
  const files = walk(
    path.join(root, "backend"),
    (name) => name.endsWith(".go") && !name.endsWith("_test.go"),
  );
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/^func ([a-z_][A-Za-z0-9_]*)[[(]/gmu)) {
      if (match[1] === "main" || match[1] === "init") continue;
      addLocation(names, match[1], relativePath(root, path.dirname(file)));
    }
  }
  return names;
}

// A top-level function declaration, or a constant bound to an arrow function
// whose parameter list ends on its first line.
const typescriptFunction = new RegExp(
  String.raw`^(export )?(?:async )?function\*? ([A-Za-z_$][\w$]*)\b|` +
    String.raw`^(export )?const ([A-Za-z_$][\w$]*)\s*(?:[:][^=\n]+)?=\s*(?:async\s*)?` +
    String.raw`(?:<[^>\n]*>\s*)?(?:\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)|[A-Za-z_$][\w$]*)\s*(?:[:][^=\n{]+)?=>`,
  "gmu",
);

/** The top-level TypeScript functions by name, and the files that declare each. */
export function typescriptHelpers(root) {
  const unexported = new Map();
  const exported = new Map();
  const files = walk(
    path.join(root, "frontend", "src"),
    (name) => /\.(?:ts|tsx)$/u.test(name) && !/\.test\.(?:ts|tsx)$/u.test(name),
  );
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const location = relativePath(root, file);
    for (const match of source.matchAll(typescriptFunction)) {
      const isExported = match[2] === undefined ? match[3] : match[1];
      addLocation(
        isExported ? exported : unexported,
        match[2] ?? match[4],
        location,
      );
    }
  }
  // A file-local helper also counts against the exported helper of that name:
  // the shared one exists, and the local copy only hides it.
  for (const [name, locations] of exported) {
    if (!unexported.has(name)) continue;
    for (const location of locations) addLocation(unexported, name, location);
  }
  return unexported;
}

function duplicates(names) {
  const result = {};
  for (const [name, locations] of [...names].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (locations.size > 1) result[name] = locations.size;
  }
  return result;
}

/** The current duplicate counts, and the Go helpers that redefine a built-in. */
export function findDuplicates(root = repositoryRoot) {
  const go = goHelpers(root);
  return {
    go: duplicates(go),
    typescript: duplicates(typescriptHelpers(root)),
    builtinLookalikes: [...go.keys()]
      .filter((name) => goBuiltinLookalike.test(name))
      .sort(),
  };
}

/** Everything the current duplicates add to the baseline, and the baseline entries that no longer hold. */
export function compare(actual, baseline) {
  const failures = [];
  const stale = [];
  for (const name of actual.builtinLookalikes) {
    failures.push(
      `go: ${name} redefines the built-in min or max; call min or max directly`,
    );
  }
  for (const language of ["go", "typescript"]) {
    const approved = baseline[language] ?? {};
    for (const [name, count] of Object.entries(actual[language])) {
      const allowed = approved[name] ?? 1;
      if (count > allowed) {
        failures.push(
          `${language}: ${name} is defined in ${count} ${language === "go" ? "packages" : "files"}, baseline allows ${allowed}`,
        );
      }
    }
    // A baseline entry above the current count would let that many copies
    // come back unreported, so the baseline only moves down with the code.
    for (const [name, allowed] of Object.entries(approved)) {
      const count = actual[language][name] ?? 1;
      if (count < allowed)
        stale.push(
          `${language}: ${name} is now defined ${count} time(s), baseline allows ${allowed}`,
        );
    }
  }
  return { failures, stale };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const actual = findDuplicates();
  if (!process.argv.includes("--update") && !fs.existsSync(baselinePath)) {
    console.error(
      "scripts/duplicate-helpers-baseline.json is missing. Restore it from git; record a new one with node scripts/check-duplicate-helpers.mjs --update only after review.",
    );
    process.exit(1);
  }
  if (process.argv.includes("--update")) {
    if (actual.builtinLookalikes.length > 0) {
      console.error(
        `Remove the Go helpers that redefine min or max first: ${actual.builtinLookalikes.join(", ")}`,
      );
      process.exit(1);
    }
    const baseline = { go: actual.go, typescript: actual.typescript };
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(
      `Recorded ${Object.keys(baseline.go).length} Go and ${Object.keys(baseline.typescript).length} TypeScript duplicate helper names.`,
    );
    process.exit(0);
  }

  const { failures, stale } = compare(
    actual,
    JSON.parse(fs.readFileSync(baselinePath, "utf8")),
  );
  if (failures.length > 0) {
    console.error(
      `Found ${failures.length} duplicate helper${failures.length === 1 ? "" : "s"}.`,
    );
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(
      "Reuse the existing helper or move it to a shared home. If the copies differ on purpose, name each for how it differs. Update scripts/duplicate-helpers-baseline.json only after review.",
    );
    process.exitCode = 1;
  }
  if (stale.length > 0) {
    console.error(
      `Found ${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} above the current count.`,
    );
    for (const entry of stale) console.error(`- ${entry}`);
    console.error(
      "Lower or remove each entry in scripts/duplicate-helpers-baseline.json and commit it with the change that removed the copies.",
    );
    process.exitCode = 1;
  }
  if (failures.length === 0 && stale.length === 0) {
    console.log(
      `Checked ${Object.keys(actual.go).length} Go and ${Object.keys(actual.typescript).length} TypeScript baseline duplicate helper names.`,
    );
  }
}
