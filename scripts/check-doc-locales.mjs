import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const userRoot = path.join(repositoryRoot, "docs", "user");
const manifestPath = path.join(userRoot, "translations.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const failures = [];

function exists(relativePath) {
  return fs.existsSync(path.join(repositoryRoot, relativePath));
}

function relativeFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

const sourceFiles = manifest.documents.map((document) => document.source);
for (const source of sourceFiles) {
  if (!exists(path.join("docs", "user", source))) {
    failures.push(`missing English source: docs/user/${source}`);
  }
}

for (const locale of manifest.locales) {
  const localeDirectory = path.join(userRoot, locale);
  if (!fs.existsSync(localeDirectory)) {
    failures.push(`missing locale directory: docs/user/${locale}`);
    continue;
  }

  const expected = sourceFiles.map((source) => path.basename(source)).sort();
  const actual = relativeFiles(localeDirectory);
  for (const file of expected) {
    if (!actual.includes(file))
      failures.push(`missing ${locale} page: docs/user/${locale}/${file}`);
  }
  for (const file of actual) {
    if (!expected.includes(file))
      failures.push(`unexpected ${locale} page: docs/user/${locale}/${file}`);
  }
}

for (const locale of manifest.locales.filter(
  (value) => value !== manifest.sourceLocale,
)) {
  const readme = `docs/readme/README.${locale}.md`;
  if (!exists(readme)) failures.push(`missing translated README: ${readme}`);
}

if (failures.length > 0) {
  console.error(`Found ${failures.length} documentation locale issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${manifest.locales.length} documentation locales and ${sourceFiles.length} user pages.`,
  );
}
