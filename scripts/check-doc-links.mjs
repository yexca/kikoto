import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const publicRootFiles = [
  "README.md",
  "AGENTS.md",
  "DESIGN.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
];
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;

function listMarkdownFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function linkTarget(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    return end > 1 ? value.slice(1, end) : value;
  }
  return value.split(/\s+/u, 1)[0];
}

function isExternalOrSpecial(target) {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(target) ||
    target.includes("<") ||
    target.includes(">")
  );
}

function resolveTarget(sourceFile, target) {
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // Keep malformed percent escapes visible as a missing path below.
  }
  const platformPath = decoded.split("/").join(path.sep);
  if (platformPath.startsWith(path.sep)) {
    return path.resolve(repositoryRoot, platformPath.slice(1));
  }
  return path.resolve(path.dirname(sourceFile), platformPath);
}

function checkFile(file) {
  const failures = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
  let fence = null;

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;

    markdownLinkPattern.lastIndex = 0;
    for (const match of line.matchAll(markdownLinkPattern)) {
      const target = linkTarget(match[1]);
      if (isExternalOrSpecial(target)) continue;
      const resolved = resolveTarget(file, target);
      if (!fs.existsSync(resolved)) {
        failures.push({ file, line: index + 1, target, resolved });
      }
    }
  }
  return failures;
}

const files = [
  ...publicRootFiles
    .map((file) => path.join(repositoryRoot, file))
    .filter(fs.existsSync),
  ...listMarkdownFiles(path.join(repositoryRoot, "docs")),
];
const failures = files.flatMap(checkFile);

if (failures.length > 0) {
  console.error(`Found ${failures.length} broken Markdown link(s):`);
  for (const failure of failures) {
    console.error(
      `- ${path.relative(repositoryRoot, failure.file)}:${failure.line} -> ${failure.target} ` +
        `(resolved to ${path.relative(repositoryRoot, failure.resolved)})`,
    );
  }
  process.exitCode = 1;
} else {
  console.log(
    `Checked ${files.length} public Markdown files; all relative links resolve.`,
  );
}
