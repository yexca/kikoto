import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const frontendSource = path.join(repositoryRoot, "frontend", "src");
const baselinePath = path.join(
  repositoryRoot,
  "scripts",
  "ui-copy-baseline.json",
);
const update = process.argv.includes("--update");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return /\.(?:ts|tsx)$/u.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
      ? [absolute]
      : [];
  });
}

function addCandidate(result, file, kind, value) {
  const text = value.replace(/\s+/gu, " ").trim();
  if (text.length < 3 || !/[A-Za-z]/u.test(text)) return;
  if (/^(?:https?|wss?):\/\//iu.test(text)) return;
  if (/(?:Promise|CustomEvent|onOpenChange|setTheme|set[A-Z]\w*\()/u.test(text))
    return;
  if (/\b(?:onOpen|selected|readOnly|busy|disabled)\s*\?/u.test(text)) return;
  if (
    /^(?:h|w|gap|text|bg|border|rounded|flex|grid|inline|absolute|relative|sm|md|lg|xl)-/u.test(
      text,
    )
  )
    return;
  const relative = path.relative(repositoryRoot, file).replaceAll("\\", "/");
  (result[relative] ??= new Set()).add(`${kind}: ${text}`);
}

function candidates(file) {
  const source = fs.readFileSync(file, "utf8");
  const found = {};
  for (const match of source.matchAll(
    /(?<![=])>\s*([A-Za-z][A-Za-z0-9 ,.!?/:()'&+\-]{2,})\s*</gu,
  )) {
    addCandidate(found, file, "text", match[1]);
  }
  for (const match of source.matchAll(
    /\b(aria-label|title|placeholder|alt|label|description)\s*=\s*["']([^"']+)["']/gu,
  )) {
    addCandidate(found, file, match[1], match[2]);
  }
  return found;
}

export { candidates };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const actual = {};
  for (const file of walk(frontendSource)) {
    const found = candidates(file);
    for (const [relative, values] of Object.entries(found))
      actual[relative] = [...values].sort();
  }

  if (update || !fs.existsSync(baselinePath)) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(
      `Recorded ${Object.values(actual).flat().length} existing UI copy entries.`,
    );
    process.exit(0);
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const failures = [];
  for (const [file, values] of Object.entries(actual)) {
    const approved = new Set(baseline[file] ?? []);
    for (const value of values)
      if (!approved.has(value)) failures.push(`${file}: ${value}`);
  }
  if (failures.length > 0) {
    console.error(
      `Found ${failures.length} new hard-coded UI copy entr${failures.length === 1 ? "y" : "ies"}.`,
    );
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(
      "Translate new user-facing copy or update scripts/ui-copy-baseline.json after review.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Checked ${Object.values(actual).flat().length} baseline UI copy entries.`,
    );
  }
}
