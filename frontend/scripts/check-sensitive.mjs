import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const allowMarker = /privacy-check:\s*allow(?:\s|$)/iu;
const urlPattern = /\b(?:https?|wss?):\/\/[^\s<>"'`]+/giu;
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const knownTokenPatterns = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/gu,
];
const sensitiveAssignmentPattern =
  /(?:^|[\s,{[])(?<key>[A-Za-z_][A-Za-z0-9_.-]*(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key)[A-Za-z0-9_.-]*)\s*(?::=|=|:)\s*(?<value>[^,\s}#]+)/iu;
const sensitiveQueryParameter = /(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key)/iu;

function runGit(argumentsList, encoding = "utf8") {
  const result = spawnSync("git", argumentsList, { cwd: repositoryRoot, encoding });
  if (result.error) {
    throw new Error(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ${argumentsList.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function changedTrackedFiles() {
  return runGit(["diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--"], "buffer")
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function untrackedFiles() {
  return runGit(["ls-files", "--others", "--exclude-standard", "-z"], "buffer")
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function addedLines(file) {
  const diff = runGit(["diff", "--no-ext-diff", "--unified=0", "--no-color", "HEAD", "--", file]);
  const lines = [];
  let newLineNumber = null;

  for (const line of diff.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      newLineNumber = Number(hunk[1]);
      continue;
    }
    if (newLineNumber === null || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push({ file, line: newLineNumber, text: line.slice(1) });
      newLineNumber += 1;
      continue;
    }
    if (line.startsWith(" ")) newLineNumber += 1;
  }

  return lines;
}

function untrackedLines(file) {
  const fullPath = path.resolve(repositoryRoot, file);
  if (!fs.lstatSync(fullPath).isFile()) {
    return [{ file, line: null, text: null, binary: true }];
  }
  const contents = fs.readFileSync(fullPath);
  if (contents.includes(0)) {
    return [{ file, line: null, text: null, binary: true }];
  }
  return contents
    .toString("utf8")
    .split(/\r?\n/u)
    .map((text, index) => ({ file, line: index + 1, text }));
}

function normalizedValue(value) {
  return value.trim().replace(/^["']|["';,]+$/gu, "");
}

function isSafePlaceholder(value) {
  const normalized = normalizedValue(value).toLowerCase();
  return (
    normalized === "" ||
    /^(?:false|true|null|undefined|none|unset|unknown|any|boolean|number|string(?:\[\])?)$/u.test(normalized) ||
    /^(?:change-me|redacted|placeholder|dummy|example(?:[-_].*)?|synthetic(?:[-_].*)?|replace(?:[-_].*)?|your(?:[-_].*)?|not-a-real(?:[-_].*)?)$/u.test(
      normalized,
    ) ||
    /^\$\{\{[^}]+\}\}$/u.test(normalized) ||
    /^\$\{[^}]+\}$/u.test(normalized) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/u.test(normalized) ||
    /^(?:process\.env|os\.getenv|env\.)/u.test(normalized) ||
    /^<[^>]+>$/u.test(normalized) ||
    /^\*{3,}$/u.test(normalized)
  );
}

function isLiteralSensitiveValue(value) {
  const normalized = normalizedValue(value);
  if (isSafePlaceholder(normalized)) return false;
  if (/^["']/u.test(value.trim())) return true;
  return /^[A-Za-z0-9+/_=-]{8,}$/u.test(normalized);
}

function isAllowedHost(host) {
  const normalized = host.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized.startsWith("127.") ||
    ["example.com", "example.net", "example.org", "example.invalid"].some(
      (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
    ) ||
    normalized === "example" ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".invalid") ||
    isDocumentationIPv4(normalized)
  );
}

function isDocumentationIPv4(value) {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  return (
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
    (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
  );
}

function isAllowedIPv4(value) {
  return value === "0.0.0.0" || value.startsWith("127.") || isDocumentationIPv4(value);
}

function parseURL(candidate) {
  const normalized = candidate
    .replace(/\$\([^)]+\)/gu, "0")
    .replace(/\$\{[^}]+\}/gu, "placeholder")
    .replace(/[),.;]+$/u, "");
  return new URL(normalized);
}

function isSensitivePath(file) {
  const normalized = file.replaceAll("\\", "/");
  const baseName = path.posix.basename(normalized).toLowerCase();
  if (baseName === ".env" || (baseName.startsWith(".env.") && baseName !== ".env.example")) return true;
  if (/^(?:data|cache|demo)\//u.test(normalized)) return true;
  if (/^config\//u.test(normalized) && !/^config\/(?:app|remote-sources)\.example\.ya?ml$/u.test(normalized)) {
    return true;
  }
  return /\.(?:db(?:-[A-Za-z0-9_-]+)?|sqlite(?:3)?|pem|key|p12|pfx|keystore|log|har|pcap)$/iu.test(baseName);
}

function containsPrivatePath(text) {
  return /(?:[A-Za-z]:[\\/](?:Users|home)[\\/]|\/(?:home|Users)\/)/u.test(text);
}

function scanLine(entry, findings) {
  if (entry.binary) {
    findings.push({ ...entry, kind: "binary file requires manual privacy review" });
    return;
  }
  if (allowMarker.test(entry.text)) return;

  if (containsPrivatePath(entry.text)) {
    findings.push({ ...entry, kind: "private local path" });
  }
  for (const pattern of knownTokenPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(entry.text)) {
      findings.push({ ...entry, kind: "credential-like value" });
      break;
    }
  }

  const assignment = entry.text.match(sensitiveAssignmentPattern);
  if (assignment?.groups && isLiteralSensitiveValue(assignment.groups.value)) {
    findings.push({ ...entry, kind: "literal value assigned to a sensitive key" });
  }

  urlPattern.lastIndex = 0;
  for (const match of entry.text.matchAll(urlPattern)) {
    try {
      const url = parseURL(match[0]);
      if (url.username !== "" || url.password !== "") {
        findings.push({ ...entry, kind: "URL contains embedded credentials" });
      }
      if (!isAllowedHost(url.hostname)) {
        findings.push({ ...entry, kind: "non-reserved service URL" });
      }
      for (const [name, value] of url.searchParams) {
        if (sensitiveQueryParameter.test(name) && !isSafePlaceholder(value)) {
          findings.push({ ...entry, kind: "URL query contains a sensitive parameter" });
          break;
        }
      }
    } catch {
      findings.push({ ...entry, kind: "malformed URL requires review" });
    }
  }

  ipv4Pattern.lastIndex = 0;
  for (const match of entry.text.matchAll(ipv4Pattern)) {
    if (!isAllowedIPv4(match[0])) {
      findings.push({ ...entry, kind: "non-loopback IPv4 address" });
      break;
    }
  }
}

function binaryTrackedFiles() {
  return runGit(["diff", "--no-ext-diff", "--numstat", "HEAD", "--"])
    .split(/\r?\n/u)
    .flatMap((line) => {
      const [added, removed, file] = line.split("\t", 3);
      return (added === "-" || removed === "-") && fs.existsSync(path.resolve(repositoryRoot, file))
        ? [{ file, line: null, text: null, binary: true }]
        : [];
    });
}

try {
  const trackedFiles = changedTrackedFiles();
  const untracked = untrackedFiles();
  const entries = [...trackedFiles.flatMap(addedLines), ...untracked.flatMap(untrackedLines), ...binaryTrackedFiles()];
  const findings = [];

  for (const file of [...trackedFiles, ...untracked]) {
    if (fs.existsSync(path.resolve(repositoryRoot, file)) && isSensitivePath(file)) {
      findings.push({ file, line: null, kind: "sensitive runtime or credential file" });
    }
  }
  for (const entry of entries) scanLine(entry, findings);

  const uniqueFindings = [
    ...new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.kind}`, finding])).values(),
  ];
  if (uniqueFindings.length > 0) {
    console.error(`Sensitive-change scan found ${uniqueFindings.length} item(s):`);
    for (const finding of uniqueFindings) {
      const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
      console.error(`- ${location}: ${finding.kind}`);
    }
    console.error("Inspect the changed line locally. Do not put credentials or real service details in tracked files.");
    process.exitCode = 1;
  } else {
    console.log(`Sensitive-change scan passed for ${trackedFiles.length + untracked.length} changed file(s).`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
