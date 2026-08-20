import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const approvedEndpointAllowlistFile = "scripts/privacy-allowlist.json";
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
  /(?:^|[\s,{[])(?<key>(?=[A-Za-z_])[A-Za-z0-9_.-]*(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key)[A-Za-z0-9_.-]*)\s*(?::=|=|:)\s*(?<value>[^,\s}#]+)/iu;
const sensitiveQueryParameter =
  /(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|private[-_]?key)/iu;

function runGit(argumentsList, encoding = "utf8") {
  const result = spawnSync("git", argumentsList, {
    cwd: repositoryRoot,
    encoding,
  });
  if (result.error) {
    throw new Error(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${argumentsList.join(" ")} failed: ${String(result.stderr).trim()}`,
    );
  }
  return result.stdout;
}

function normalizeRepositoryPath(file) {
  return file.replaceAll("\\", "/");
}

function canonicalEndpointURL(value) {
  const parsed = value instanceof URL ? value : new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("endpoint must use HTTP(S)");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("endpoint must not contain credentials");
  }
  if (parsed.hash !== "") {
    throw new Error("endpoint must not contain a fragment");
  }
  return parsed.toString();
}

function validateAllowlistFile(file, entryIndex) {
  if (typeof file !== "string" || file.trim() === "") {
    throw new Error(`endpoint ${entryIndex} has an invalid owner file`);
  }
  const normalized = normalizeRepositoryPath(file);
  if (
    normalized !== file ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(
      `endpoint ${entryIndex} owner file must be a repository-relative path`,
    );
  }
  return normalized;
}

export function parseApprovedEndpointAllowlist(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("root must be an object");
  }
  const rootKeys = Object.keys(parsed).sort();
  if (
    rootKeys.join(",") !== "endpoints,version" ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.endpoints)
  ) {
    throw new Error("root must contain only version 1 and an endpoints array");
  }

  const endpoints = new Map();
  for (const [index, entry] of parsed.endpoints.entries()) {
    const entryIndex = index + 1;
    if (entry === null || Array.isArray(entry) || typeof entry !== "object") {
      throw new Error(`endpoint ${entryIndex} must be an object`);
    }
    const entryKeys = Object.keys(entry).sort();
    if (entryKeys.join(",") !== "files,reason,url") {
      throw new Error(
        `endpoint ${entryIndex} must contain only url, files, and reason`,
      );
    }
    if (
      typeof entry.url !== "string" ||
      entry.url.trim() === "" ||
      entry.url !== entry.url.trim()
    ) {
      throw new Error(`endpoint ${entryIndex} has an invalid URL`);
    }
    let url;
    try {
      url = canonicalEndpointURL(entry.url);
    } catch (error) {
      throw new Error(
        `endpoint ${entryIndex} has an invalid URL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(`endpoint ${entryIndex} must have a reason`);
    }
    if (!Array.isArray(entry.files) || entry.files.length === 0) {
      throw new Error(
        `endpoint ${entryIndex} must declare at least one owner file`,
      );
    }
    if (endpoints.has(url)) {
      throw new Error(`endpoint ${entryIndex} duplicates an approved URL`);
    }
    const files = new Set();
    for (const file of entry.files) {
      const normalized = validateAllowlistFile(file, entryIndex);
      if (files.has(normalized)) {
        throw new Error(`endpoint ${entryIndex} repeats an owner file`);
      }
      files.add(normalized);
    }
    endpoints.set(url, { files, reason: entry.reason });
  }
  return endpoints;
}

function loadApprovedEndpointAllowlist() {
  const fullPath = path.resolve(repositoryRoot, approvedEndpointAllowlistFile);
  let endpoints;
  try {
    endpoints = parseApprovedEndpointAllowlist(
      fs.readFileSync(fullPath, "utf8"),
    );
  } catch (error) {
    throw new Error(
      `${approvedEndpointAllowlistFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const endpoint of endpoints.values()) {
    for (const file of endpoint.files) {
      if (!fs.existsSync(path.resolve(repositoryRoot, file))) {
        throw new Error(
          `${approvedEndpointAllowlistFile}: owner file does not exist: ${file}`,
        );
      }
    }
  }
  return endpoints;
}

export function isApprovedPublicEndpoint(file, url, endpoints) {
  let canonicalURL;
  try {
    canonicalURL = canonicalEndpointURL(url);
  } catch {
    return false;
  }
  const endpoint = endpoints.get(canonicalURL);
  if (endpoint === undefined) return false;
  const normalizedFile = normalizeRepositoryPath(file);
  return (
    normalizedFile === approvedEndpointAllowlistFile ||
    endpoint.files.has(normalizedFile)
  );
}

function changedTrackedFiles() {
  return runGit(
    ["diff", "--no-ext-diff", "--name-only", "-z", "HEAD", "--"],
    "buffer",
  )
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
  const diff = runGit([
    "diff",
    "--no-ext-diff",
    "--unified=0",
    "--no-color",
    "HEAD",
    "--",
    file,
  ]);
  const lines = [];
  let newLineNumber = null;

  for (const line of diff.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      newLineNumber = Number(hunk[1]);
      continue;
    }
    if (newLineNumber === null || line === "\\ No newline at end of file")
      continue;
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
    /^(?:false|true|null|undefined|none|unset|unknown|any|boolean|number|string(?:\[\])?)$/u.test(
      normalized,
    ) ||
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
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return (
    (octets[0] === 192 && octets[1] === 0 && octets[2] === 2) ||
    (octets[0] === 198 && octets[1] === 51 && octets[2] === 100) ||
    (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
  );
}

function isAllowedIPv4(value) {
  return (
    value === "0.0.0.0" ||
    value.startsWith("127.") ||
    isDocumentationIPv4(value)
  );
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
  if (
    baseName === ".env" ||
    (baseName.startsWith(".env.") && baseName !== ".env.example")
  )
    return true;
  if (/^(?:data|cache|demo)\//u.test(normalized)) return true;
  if (
    /^config\//u.test(normalized) &&
    !/^config\/(?:app|remote-sources)\.example\.ya?ml$/u.test(normalized)
  ) {
    return true;
  }
  return /\.(?:db(?:-[A-Za-z0-9_-]+)?|sqlite(?:3)?|pem|key|p12|pfx|keystore|log|har|pcap)$/iu.test(
    baseName,
  );
}

function containsPrivatePath(text) {
  return /(?:[A-Za-z]:[\\/](?:Users|home)[\\/]|\/(?:home|Users)\/)/u.test(text);
}

export function scanLine(entry, findings, approvedEndpoints) {
  if (entry.binary) {
    findings.push({
      ...entry,
      kind: "binary file requires manual privacy review",
    });
    return;
  }

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
    findings.push({
      ...entry,
      kind: "literal value assigned to a sensitive key",
    });
  }

  urlPattern.lastIndex = 0;
  for (const match of entry.text.matchAll(urlPattern)) {
    try {
      const url = parseURL(match[0]);
      if (url.username !== "" || url.password !== "") {
        findings.push({ ...entry, kind: "URL contains embedded credentials" });
      }
      if (
        !isAllowedHost(url.hostname) &&
        !isApprovedPublicEndpoint(entry.file, url, approvedEndpoints)
      ) {
        findings.push({ ...entry, kind: "non-reserved service URL" });
      }
      for (const [name, value] of url.searchParams) {
        if (sensitiveQueryParameter.test(name) && !isSafePlaceholder(value)) {
          findings.push({
            ...entry,
            kind: "URL query contains a sensitive parameter",
          });
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
      return (added === "-" || removed === "-") &&
        fs.existsSync(path.resolve(repositoryRoot, file))
        ? [{ file, line: null, text: null, binary: true }]
        : [];
    });
}

export function runSensitiveCheck() {
  const approvedEndpoints = loadApprovedEndpointAllowlist();
  const trackedFiles = changedTrackedFiles();
  const untracked = untrackedFiles();
  const entries = [
    ...trackedFiles.flatMap(addedLines),
    ...untracked.flatMap(untrackedLines),
    ...binaryTrackedFiles(),
  ];
  const findings = [];
  const allowlistChanged = [...trackedFiles, ...untracked].some(
    (file) => normalizeRepositoryPath(file) === approvedEndpointAllowlistFile,
  );

  for (const file of [...trackedFiles, ...untracked]) {
    if (
      fs.existsSync(path.resolve(repositoryRoot, file)) &&
      isSensitivePath(file)
    ) {
      findings.push({
        file,
        line: null,
        kind: "sensitive runtime or credential file",
      });
    }
  }
  for (const entry of entries) scanLine(entry, findings, approvedEndpoints);

  const uniqueFindings = [
    ...new Map(
      findings.map((finding) => [
        `${finding.file}:${finding.line}:${finding.kind}`,
        finding,
      ]),
    ).values(),
  ];
  if (uniqueFindings.length > 0) {
    console.error(
      `Sensitive-change scan found ${uniqueFindings.length} item(s):`,
    );
    for (const finding of uniqueFindings) {
      const location =
        finding.line === null
          ? finding.file
          : `${finding.file}:${finding.line}`;
      console.error(`- ${location}: ${finding.kind}`);
    }
    console.error(
      "Inspect the changed line locally. Do not put credentials or real service details in tracked files.",
    );
    return 1;
  } else {
    if (allowlistChanged) {
      console.warn(
        `Approved public endpoint allowlist changed: ${approvedEndpointAllowlistFile}. Review every URL, owner file, and reason before committing.`,
      );
    }
    console.log(
      `Sensitive-change scan passed for ${trackedFiles.length + untracked.length} changed file(s).`,
    );
    return 0;
  }
}

function main() {
  try {
    process.exitCode = runSensitiveCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
