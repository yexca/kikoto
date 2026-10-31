import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const approvedEndpointAllowlistFile = "scripts/privacy-allowlist.json";
const localPrivacyBlocklistFile = ".privacy-blocklist";
const urlPattern = /\b(?:https?|wss?):\/\/[^\s<>"'`]+/giu;
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const ipv6Pattern = /(?<![A-Za-z0-9])[0-9A-Fa-f:]{2,}(?![A-Za-z0-9])/gu;
// The well-known private and link-local IPv4 networks, written exactly as
// these CIDR blocks, name no particular machine. Any address inside them is
// still flagged.
const wellKnownPrivateIPv4Networks =
  /(?<![\d.])(?:10\.0\.0\.0\/8|172\.16\.0\.0\/12|192\.168\.0\.0\/16|169\.254\.0\.0\/16)(?!\d|\.\d)/gu;
const knownTokenPatterns = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/gu,
];
// "token" excludes tokenizer options such as SQLite FTS5 `tokenize = 'trigram'`,
// which name a text-splitting algorithm rather than a credential.
const sensitiveAssignmentPattern =
  /(?:^|[\s,{[])(?<key>(?=[A-Za-z_])[A-Za-z0-9_.-]*(?:password|passwd|token(?!iz)|secret|api[-_]?key|access[-_]?key|private[-_]?key)[A-Za-z0-9_.-]*)\s*(?::=|=|:)\s*(?<value>[^,\s}#]+)/iu;
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

function hasWildcard(value) {
  return value.includes("*");
}

// `*` matches within one segment and a whole `**` segment matches zero or more
// segments. No other glob syntax is supported.
function compileGlobSegments(segments, label) {
  return segments.map((segment) => {
    if (segment === "**") return segment;
    if (segment.includes("**")) {
      throw new Error(`${label} may use ** only as a whole segment`);
    }
    const source = segment
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join("[^/]*");
    return new RegExp(`^${source}$`, "u");
  });
}

function matchGlobSegments(patterns, segments) {
  if (patterns.length === 0) return segments.length === 0;
  const [pattern, ...remainingPatterns] = patterns;
  if (pattern === "**") {
    for (let skipped = 0; skipped <= segments.length; skipped += 1) {
      if (matchGlobSegments(remainingPatterns, segments.slice(skipped))) {
        return true;
      }
    }
    return false;
  }
  return (
    segments.length > 0 &&
    pattern.test(segments[0]) &&
    matchGlobSegments(remainingPatterns, segments.slice(1))
  );
}

function pathSegments(pathname) {
  return pathname.slice(1).split("/");
}

function compileEndpointMatcher(value) {
  const canonical = canonicalEndpointURL(value);
  if (!hasWildcard(value)) {
    return { key: canonical, matches: (url) => url.toString() === canonical };
  }
  const parsed = new URL(canonical);
  if (hasWildcard(parsed.protocol) || hasWildcard(parsed.host)) {
    throw new Error("wildcards are allowed only in the URL path");
  }
  if (parsed.search !== "") {
    throw new Error("a wildcard URL must not contain a query");
  }
  const segments = compileGlobSegments(
    pathSegments(parsed.pathname),
    "URL path",
  );
  // A wildcard entry approves an origin and path shape. Its query is ignored
  // here because scanLine checks query parameters separately.
  return {
    key: canonical,
    matches: (url) =>
      url.origin === parsed.origin &&
      matchGlobSegments(segments, pathSegments(url.pathname)),
  };
}

function compileOwnerFileMatcher(file) {
  if (!hasWildcard(file)) {
    return { pattern: file, isGlob: false, matches: (other) => other === file };
  }
  const segments = compileGlobSegments(file.split("/"), "owner file");
  return {
    pattern: file,
    isGlob: true,
    matches: (other) => matchGlobSegments(segments, other.split("/")),
  };
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

  const endpoints = [];
  const approvedURLs = new Set();
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
    let urlMatcher;
    try {
      urlMatcher = compileEndpointMatcher(entry.url);
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
    if (approvedURLs.has(urlMatcher.key)) {
      throw new Error(`endpoint ${entryIndex} duplicates an approved URL`);
    }
    approvedURLs.add(urlMatcher.key);
    const ownerFiles = new Set();
    const files = [];
    for (const file of entry.files) {
      const normalized = validateAllowlistFile(file, entryIndex);
      if (ownerFiles.has(normalized)) {
        throw new Error(`endpoint ${entryIndex} repeats an owner file`);
      }
      ownerFiles.add(normalized);
      try {
        files.push(compileOwnerFileMatcher(normalized));
      } catch (error) {
        throw new Error(
          `endpoint ${entryIndex} has an invalid owner file: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    endpoints.push({
      matchesURL: urlMatcher.matches,
      files,
      reason: entry.reason,
    });
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
  let repositoryFiles;
  for (const endpoint of endpoints) {
    for (const file of endpoint.files) {
      if (!file.isGlob) {
        if (!fs.existsSync(path.resolve(repositoryRoot, file.pattern))) {
          throw new Error(
            `${approvedEndpointAllowlistFile}: owner file does not exist: ${file.pattern}`,
          );
        }
        continue;
      }
      repositoryFiles ??= [...trackedFiles(), ...untrackedFiles()].filter(
        (candidate) => fs.existsSync(path.resolve(repositoryRoot, candidate)),
      );
      if (!repositoryFiles.some((candidate) => file.matches(candidate))) {
        throw new Error(
          `${approvedEndpointAllowlistFile}: owner file pattern matches no file: ${file.pattern}`,
        );
      }
    }
  }
  return endpoints;
}

// The local blocklist is deliberately a plain text file: it can contain private
// work codes and paths from a developer's data directory without becoming a
// repository fixture. Values are matched literally, not as regular
// expressions, so a path cannot change the scanner's matching behavior.
export function parsePrivacyBlocklist(contents) {
  if (contents.includes("\0")) {
    throw new Error("blocklist must be a text file");
  }
  const values = [];
  const seen = new Set();
  for (const [index, rawLine] of contents
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .entries()) {
    const value = rawLine.trim();
    if (value === "" || value.startsWith("#")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
    if (values.length > 10_000) {
      throw new Error(`blocklist has too many entries (line ${index + 1})`);
    }
  }
  return values;
}

function loadPrivacyBlocklist() {
  const fullPath = path.resolve(repositoryRoot, localPrivacyBlocklistFile);
  if (!fs.existsSync(fullPath)) return [];
  if (trackedFiles().includes(localPrivacyBlocklistFile)) {
    throw new Error(
      `${localPrivacyBlocklistFile} must remain untracked; keep private local values out of Git`,
    );
  }
  if (
    !gitIgnoredPaths([localPrivacyBlocklistFile], repositoryRoot).has(
      localPrivacyBlocklistFile,
    )
  ) {
    throw new Error(
      `${localPrivacyBlocklistFile} must be ignored by Git so private local values cannot be staged accidentally`,
    );
  }
  let contents;
  try {
    contents = fs.readFileSync(fullPath, "utf8");
  } catch (error) {
    throw new Error(
      `${localPrivacyBlocklistFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parsePrivacyBlocklist(contents);
  } catch (error) {
    throw new Error(
      `${localPrivacyBlocklistFile}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function isApprovedPublicEndpoint(file, url, endpoints) {
  let candidate;
  try {
    candidate = new URL(canonicalEndpointURL(url));
  } catch {
    return false;
  }
  const normalizedFile = normalizeRepositoryPath(file);
  return endpoints.some(
    (endpoint) =>
      endpoint.matchesURL(candidate) &&
      (normalizedFile === approvedEndpointAllowlistFile ||
        endpoint.files.some((owner) => owner.matches(normalizedFile))),
  );
}

function trackedFiles() {
  return runGit(["ls-files", "--cached", "-z"], "buffer")
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
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

// Bare JavaScript identifiers pass a value from state; they are not string
// literals. Environment and YAML files still treat unquoted values as data.
function isCodeValueReference(entry, value) {
  return (
    /\.(?:[cm]?js|tsx?)$/iu.test(entry.file) &&
    /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value)
  );
}

// These exact public UI strings name a control, not a credential. Keep the
// owner scope narrow; token, URL and path checks still inspect every line.
const credentialControlCopy = new Set([
  "API key",
  "API 密钥",
  "API 金鑰",
  "API キー",
  "API 키",
  "Keys are stored by the server and are never returned to the browser.",
  "密钥由服务器保存，不会返回到浏览器。",
  "金鑰由伺服器保存，不會回傳到瀏覽器。",
  "キーはサーバーに保存され、ブラウザーには返されません。",
  "키는 서버에 저장되며 브라우저로 반환되지 않습니다.",
]);
function isCredentialControlCopy(entry) {
  if (
    !/^frontend\/src\/i18n\/surfaces\/(?:en|ja|ko|zh-Hans|zh-Hant)\.ts$/u.test(
      entry.file,
    )
  )
    return false;
  const match = entry.text.match(
    /^\s*apiKey(?:Description)?:\s*("(?:\\.|[^"\\])*")\s*,?\s*$/u,
  );
  if (!match) return false;
  try {
    return credentialControlCopy.has(JSON.parse(match[1]));
  } catch {
    return false;
  }
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

function isAllowedIPv6(value) {
  const normalized = value
    .replace(/^\[|\]$/gu, "")
    .split("%")[0]
    .toLowerCase();
  if (!net.isIPv6(normalized)) return true;
  return (
    normalized === "::1" ||
    normalized.startsWith("2001:db8:") ||
    normalized === "2001:db8"
  );
}

function parseURL(candidate) {
  // A Markdown link target ends at the first unmatched ")", even when text
  // without a separating space, such as CJK prose, follows it.
  const closing = candidate.indexOf(")");
  if (closing >= 0 && !candidate.slice(0, closing).includes("(")) {
    candidate = candidate.slice(0, closing);
  }
  const normalized = candidate
    .replace(/\$\([^)]+\)/gu, "0")
    .replace(/\$\{[^}]+\}/gu, "placeholder")
    .replace(/[),.;]+$/u, "");
  return new URL(normalized);
}

function isSensitivePath(file) {
  const normalized = file.replaceAll("\\", "/");
  const baseName = path.posix.basename(normalized).toLowerCase();
  if (normalized === localPrivacyBlocklistFile) return true;
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

// gitIgnoredPaths returns the files that the repository's ignore rules match,
// including files that are already tracked, such as one added with --force.
function gitIgnoredPaths(files, root) {
  if (files.length === 0) return new Set();
  const result = spawnSync(
    "git",
    ["check-ignore", "--no-index", "--stdin", "-z"],
    { cwd: root, input: Buffer.from(files.join("\0") + "\0", "utf8") },
  );
  if (result.error) {
    throw new Error(`could not run git: ${result.error.message}`);
  }
  // check-ignore exits 1 when no file is ignored.
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `git check-ignore failed: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean));
}

// sensitivePaths returns the files that must not be committed. A repository
// with a root .gitignore defines them by its ignore rules; without one, the
// built-in runtime and credential path rules apply.
export function sensitivePaths(files, root = repositoryRoot) {
  if (!fs.existsSync(path.join(root, ".gitignore"))) {
    return files.filter(isSensitivePath);
  }
  const ignored = gitIgnoredPaths(files, root);
  return files.filter((file) => ignored.has(file));
}

function containsPrivatePath(text) {
  return /(?:[A-Za-z]:[\\/](?:Users|home)[\\/]|\/(?:home|Users)\/)/u.test(text);
}

export function scanLine(
  entry,
  findings,
  approvedEndpoints,
  blockedValues = [],
) {
  const blockedValue = blockedValues.find(
    (value) =>
      entry.file.includes(value) ||
      (typeof entry.text === "string" && entry.text.includes(value)),
  );
  if (blockedValue !== undefined) {
    findings.push({ ...entry, kind: "locally blocked privacy value" });
  }

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
  if (
    assignment?.groups &&
    isLiteralSensitiveValue(assignment.groups.value) &&
    !isCodeValueReference(entry, assignment.groups.value) &&
    !isCredentialControlCopy(entry)
  ) {
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
  const addressText = entry.text.replace(wellKnownPrivateIPv4Networks, "");
  for (const match of addressText.matchAll(ipv4Pattern)) {
    if (!isAllowedIPv4(match[0])) {
      findings.push({ ...entry, kind: "non-loopback IPv4 address" });
      break;
    }
  }

  ipv6Pattern.lastIndex = 0;
  for (const match of entry.text.matchAll(ipv6Pattern)) {
    if (!isAllowedIPv6(match[0])) {
      findings.push({ ...entry, kind: "non-loopback IPv6 address" });
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
  const blockedValues = loadPrivacyBlocklist();
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

  const presentFiles = [...trackedFiles, ...untracked].filter((file) =>
    fs.existsSync(path.resolve(repositoryRoot, file)),
  );
  for (const file of sensitivePaths(presentFiles)) {
    findings.push({
      file,
      line: null,
      kind: "sensitive runtime or credential file",
    });
  }
  for (const entry of entries) {
    scanLine(entry, findings, approvedEndpoints, blockedValues);
  }

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
