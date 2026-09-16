import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const publicRootFiles = [
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
];
const markdownLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
const htmlLinkPattern =
  /<(?:a|img)\b[^>]*?\b(?:href|src)\s*=\s*(["'])(.*?)\1/giu;

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

function resolveTarget(sourceFile, target, root) {
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // Keep malformed percent escapes visible as a missing path below.
  }
  const platformPath = decoded.split("/").join(path.sep);
  if (platformPath.startsWith(path.sep)) {
    return path.resolve(root, platformPath.slice(1));
  }
  return path.resolve(path.dirname(sourceFile), platformPath);
}

export function checkFile(file, root = repositoryRoot) {
  const failures = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
  let fence = null;
  const visibleLines = [];

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === null ? marker : fence === marker ? null : fence;
      visibleLines.push("");
      continue;
    }
    visibleLines.push(fence === null ? line : "");
  }
  // README language navigation and artwork use HTML, including multiline tags.
  // Keep line breaks when excluding code fences so diagnostics stay accurate.
  const source = visibleLines.join("\n");
  const links = [
    ...Array.from(source.matchAll(markdownLinkPattern), (match) => ({
      index: match.index,
      target: linkTarget(match[1]),
    })),
    ...Array.from(source.matchAll(htmlLinkPattern), (match) => ({
      index: match.index,
      target: match[2],
    })),
  ];
  for (const { index, target } of links) {
    if (isExternalOrSpecial(target)) continue;
    const resolved = resolveTarget(file, target, root);
    if (!fs.existsSync(resolved)) {
      failures.push({
        file,
        line: source.slice(0, index).split("\n").length,
        target,
        resolved,
      });
    }
  }
  return failures.sort((a, b) => a.line - b.line);
}

function main() {
  const files = [
    ...publicRootFiles
      .map((file) => path.join(repositoryRoot, file))
      .filter(fs.existsSync),
    ...listMarkdownFiles(path.join(repositoryRoot, "docs")),
  ];
  const failures = files.flatMap((file) => checkFile(file));

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
