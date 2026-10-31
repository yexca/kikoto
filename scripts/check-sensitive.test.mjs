import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseApprovedEndpointAllowlist,
  parsePrivacyBlocklist,
  scanLine,
  sensitivePaths,
} from "./check-sensitive.mjs";

const ownerFile = "backend/internal/dlsite/endpoints.go";

function endpointFor(host) {
  const endpoint = new URL("https://example.invalid");
  endpoint.hostname = host;
  return endpoint.toString();
}

function approvedEndpoint() {
  return endpointFor(["www", "dlsite", "com"].join("."));
}

function allowlistWith(...endpoints) {
  return parseApprovedEndpointAllowlist(
    JSON.stringify({
      version: 1,
      endpoints: endpoints.map(({ url, files }) => ({
        url,
        files,
        reason: "Test-only approved public endpoint.",
      })),
    }),
  );
}

function approvedAllowlist() {
  return allowlistWith({ url: approvedEndpoint(), files: [ownerFile] });
}

function urlFindings(file, urls, allowlist) {
  const findings = [];
  for (const [index, url] of urls.entries()) {
    scanLine(
      { file, line: index + 1, text: `const endpoint = "${url}";` },
      findings,
      allowlist,
    );
  }
  return findings.map((finding) => `${finding.line}:${finding.kind}`);
}

const codeHost = ["code", "host", "net"].join(".");

test("matches a ** URL path at any depth only under the declared origin and prefix", () => {
  const repository = `${endpointFor(codeHost)}owner/project`;
  const allowlist = allowlistWith({
    url: `${repository}/**`,
    files: [ownerFile],
  });

  assert.deepEqual(
    urlFindings(
      ownerFile,
      [
        repository,
        `${repository}/releases`,
        `${repository}/tags?per_page=100`,
        `${repository}-fork`,
        `${endpointFor(codeHost)}owner/other`,
        `${endpointFor(`api.${codeHost}`)}owner/project`,
        `${repository.replace("https:", "http:")}/releases`,
      ],
      allowlist,
    ),
    [
      "4:non-reserved service URL",
      "5:non-reserved service URL",
      "6:non-reserved service URL",
      "7:non-reserved service URL",
    ],
  );
  assert.deepEqual(
    urlFindings("README.md", [`${repository}/releases`], allowlist),
    ["1:non-reserved service URL"],
  );
});

test("matches a * URL segment without crossing a path separator", () => {
  const sponsors = `${endpointFor(codeHost)}sponsors`;
  const allowlist = allowlistWith({
    url: `${sponsors}/*`,
    files: [ownerFile],
  });

  assert.deepEqual(
    urlFindings(
      ownerFile,
      [`${sponsors}/maintainer`, `${sponsors}/maintainer/extra`, sponsors],
      allowlist,
    ),
    ["2:non-reserved service URL", "3:non-reserved service URL"],
  );
});

test("matches owner-file globs by path segment", () => {
  const registry = endpointFor(["registry", "npmjs", "org"].join("."));
  const allowlist = allowlistWith(
    { url: `${registry}**`, files: ["**/package-lock.json"] },
    { url: approvedEndpoint(), files: ["helper/helper.*.ps1"] },
  );

  for (const file of ["package-lock.json", "frontend/package-lock.json"]) {
    assert.deepEqual(
      urlFindings(file, [`${registry}pkg/-/pkg-1.0.0.tgz`], allowlist),
      [],
    );
  }
  assert.deepEqual(
    urlFindings("frontend/package.json", [`${registry}pkg`], allowlist),
    ["1:non-reserved service URL"],
  );
  assert.deepEqual(
    urlFindings("helper/helper.en.ps1", [approvedEndpoint()], allowlist),
    [],
  );
  for (const file of ["helper/nested/helper.en.ps1", "helper/helper.cmd"]) {
    assert.deepEqual(urlFindings(file, [approvedEndpoint()], allowlist), [
      "1:non-reserved service URL",
    ]);
  }
});

test("still flags a sensitive query on a wildcard-approved URL", () => {
  const repository = `${endpointFor(codeHost)}owner/project`;
  const sensitiveParameter = ["access", "token"].join("_");
  const allowlist = allowlistWith({
    url: `${repository}/**`,
    files: [ownerFile],
  });

  assert.deepEqual(
    urlFindings(
      ownerFile,
      [`${repository}/tags?${sensitiveParameter}=abcdef123456`],
      allowlist,
    ),
    ["1:URL query contains a sensitive parameter"],
  );
});

test("rejects wildcards outside the URL path and malformed globs", () => {
  const cases = [
    [
      { url: `${endpointFor(codeHost).replace("//", "//*.")}owner/**` },
      /only in the URL path/,
    ],
    [
      { url: `${endpointFor(codeHost).replace(/\/$/u, ":*/")}owner/**` },
      /invalid URL/,
    ],
    [
      { url: `${endpointFor(codeHost)}owner/**?page=1` },
      /must not contain a query/,
    ],
    [
      { url: `${endpointFor(codeHost)}owner/a**` },
      /\*\* only as a whole segment/,
    ],
    [
      { url: approvedEndpoint(), files: ["frontend/**.ts"] },
      /\*\* only as a whole segment/,
    ],
  ];
  for (const [entry, expected] of cases) {
    assert.throws(
      () => allowlistWith({ files: [ownerFile], ...entry }),
      expected,
    );
  }
});

test("ends a Markdown link target at its closing parenthesis before CJK text", () => {
  const endpoint = approvedEndpoint();
  const allowlist = approvedAllowlist();
  const findings = [];
  for (const [line, suffix] of ["를 따릅니다.", "。", " follows."].entries()) {
    scanLine(
      { file: ownerFile, line: line + 1, text: `[API](${endpoint})${suffix}` },
      findings,
      allowlist,
    );
  }
  assert.deepEqual(findings, []);
});

test("allows an exact approved endpoint only in its declared file", () => {
  const endpoint = approvedEndpoint();
  const allowlist = approvedAllowlist();
  const findings = [];

  scanLine(
    { file: ownerFile, line: 1, text: `const endpoint = "${endpoint}";` },
    findings,
    allowlist,
  );
  assert.deepEqual(findings, []);

  scanLine(
    {
      file: "frontend/src/lib/other-links.ts",
      line: 1,
      text: `const endpoint = "${endpoint}";`,
    },
    findings,
    allowlist,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "non-reserved service URL");
});

test("does not honor legacy per-line allow markers", () => {
  const endpoint = approvedEndpoint();
  const obsoleteMarker = ["privacy-check:", "allow"].join(" ");
  const findings = [];

  scanLine(
    {
      file: "frontend/src/lib/other-links.ts",
      line: 1,
      text: `const endpoint = "${endpoint}"; // ${obsoleteMarker}`,
    },
    findings,
    approvedAllowlist(),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "non-reserved service URL");
});

test("does not suppress other sensitive content on an approved endpoint line", () => {
  const endpoint = approvedEndpoint();
  const sensitiveKey = ["api", "Key"].join("");
  const findings = [];

  scanLine(
    {
      file: ownerFile,
      line: 1,
      text: `const endpoint = "${endpoint}"; const ${sensitiveKey} = "value";`,
    },
    findings,
    approvedAllowlist(),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "literal value assigned to a sensitive key");
});

test("treats tokenizer options as configuration, not credentials", () => {
  const findings = [];

  scanLine(
    {
      file: "backend/migrations/001_example.sql",
      line: 1,
      text: "  tokenize = 'trigram'",
    },
    findings,
    approvedAllowlist(),
  );

  assert.deepEqual(findings, []);
});

test("distinguishes state references from literals without relaxing configuration files", () => {
  const findings = [];
  scanLine(
    { file: "frontend/src/example.tsx", line: 1, text: "apiKey: newAPIKey," },
    findings,
    approvedAllowlist(),
  );
  assert.deepEqual(findings, []);
  scanLine(
    { file: "config.yaml", line: 1, text: "apiKey: newAPIKey" },
    findings,
    approvedAllowlist(),
  );
  assert.equal(findings.length, 1);
  scanLine(
    {
      file: "frontend/src/example.tsx",
      line: 2,
      text: 'apiKey: "ordinaryvalue123",',
    },
    findings,
    approvedAllowlist(),
  );
  assert.equal(findings.length, 2);
});

test("permits only exact credential control copy in its localization owners", () => {
  const findings = [];
  scanLine(
    {
      file: "frontend/src/i18n/surfaces/en.ts",
      line: 1,
      text: 'apiKey: "API key",',
    },
    findings,
    approvedAllowlist(),
  );
  scanLine(
    {
      file: "frontend/src/i18n/surfaces/en.ts",
      line: 2,
      text: 'apiKeyDescription: "Keys are stored by the server and are never returned to the browser.",',
    },
    findings,
    approvedAllowlist(),
  );
  assert.deepEqual(findings, []);
  scanLine(
    { file: "config.ts", line: 1, text: 'apiKey: "API key",' },
    findings,
    approvedAllowlist(),
  );
  scanLine(
    {
      file: "frontend/src/i18n/surfaces/en.ts",
      line: 3,
      text: 'apiKey: "ordinaryvalue123",',
    },
    findings,
    approvedAllowlist(),
  );
  assert.equal(findings.length, 2);
});

test("still flags a credential key that follows a tokenizer prefix", () => {
  const sensitiveKey = ["tokenizer", "Token"].join("");
  const findings = [];

  scanLine(
    { file: "config.js", line: 1, text: `const ${sensitiveKey} = "value";` },
    findings,
    approvedAllowlist(),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "literal value assigned to a sensitive key");
});

test("parses a local privacy blocklist without treating values as patterns", () => {
  assert.deepEqual(
    parsePrivacyBlocklist(
      "\uFEFF# local values\r\nRJ00000042\r\n  D:\\Library\\Private Work  \r\nRJ00000042\n",
    ),
    ["RJ00000042", "D:\\Library\\Private Work"],
  );
  assert.throws(
    () => parsePrivacyBlocklist("text\0binary"),
    /must be a text file/,
  );
});

test("reports local privacy blocklist matches in content and file names", () => {
  const findings = [];
  const blockedValue = "RJ00000042";
  scanLine(
    {
      file: `backend/tests/${blockedValue}_test.go`,
      line: 1,
      text: `const workCode = "${blockedValue}"`,
    },
    findings,
    approvedAllowlist(),
    [blockedValue],
  );
  assert.deepEqual(
    findings.map(({ kind, line, file }) => ({ kind, line, file })),
    [
      {
        kind: "locally blocked privacy value",
        line: 1,
        file: `backend/tests/${blockedValue}_test.go`,
      },
    ],
  );

  const fileNameFindings = [];
  scanLine(
    {
      file: `backend/tests/${blockedValue}_test.go`,
      line: 1,
      text: 'const workCode = "RJ00000000"',
    },
    fileNameFindings,
    approvedAllowlist(),
    [blockedValue],
  );
  assert.deepEqual(
    fileNameFindings.map(({ kind }) => kind),
    ["locally blocked privacy value"],
  );
});

test("rejects malformed endpoint allowlist entries", () => {
  assert.throws(
    () =>
      parseApprovedEndpointAllowlist(
        JSON.stringify({
          version: 1,
          endpoints: [{ url: approvedEndpoint(), files: [], reason: "test" }],
        }),
      ),
    /must declare at least one owner file/,
  );
});

test("allows the well-known private networks only as exact CIDR blocks", () => {
  const scan = (text) => {
    const findings = [];
    scanLine(
      { file: "backend/internal/example.go", line: 1, text },
      findings,
      approvedAllowlist(),
    );
    return findings.map((finding) => finding.kind);
  };

  // Addresses are assembled so this file does not itself hold them.
  const address = (...octets) => octets.join(".");
  assert.deepEqual(
    scan(
      'defaults := []string{"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"}',
    ),
    [],
  );
  assert.deepEqual(scan("a network such as 192.168.0.0/16."), []);
  for (const text of [
    `host := "${address(192, 168, 1, 20)}"`,
    `network := "${address(192, 168, 1, 0)}/24"`,
    `network := "${address(10, 0, 0, 0)}/16"`,
    `pair := "192.168.0.0/16 ${address(10, 1, 2, 3)}"`,
    `longer := "${"192.168.0.0/16"}1"`,
  ]) {
    assert.deepEqual(scan(text), ["non-loopback IPv4 address"], text);
  }
});

test("reports bare IPv6 addresses while allowing loopback and documentation addresses", () => {
  const scan = (text) => {
    const findings = [];
    scanLine(
      { file: "backend/internal/example.go", line: 1, text },
      findings,
      approvedAllowlist(),
    );
    return findings.map((finding) => finding.kind);
  };

  const address = (...parts) => parts.join(":");
  assert.deepEqual(scan(`host := "${address("fd00", "", "1")}"`), [
    "non-loopback IPv6 address",
  ]);
  assert.deepEqual(scan(`host := "${address("fe80", "", "1")}"`), [
    "non-loopback IPv6 address",
  ]);
  assert.deepEqual(scan(`host := "${address("", "", "1")}"`), []);
  assert.deepEqual(scan(`host := "${address("2001", "db8", "", "1")}"`), []);
});

function temporaryRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kikoto-sensitive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root });
  assert.equal(init.status, 0, String(init.stderr));
  return root;
}

test("reports changed files that the repository's ignore rules match", (t) => {
  const root = temporaryRepository(t);
  fs.writeFileSync(
    path.join(root, ".gitignore"),
    "runtime/*\n!runtime/.gitkeep\n*.pem\n",
  );
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", ".gitignore"), "local.txt\n");

  assert.deepEqual(
    sensitivePaths(
      [
        "runtime/library.db",
        "runtime/.gitkeep",
        "nested/local.txt",
        "nested/shared.txt",
        "certs/server.pem",
        "data/notes.txt",
        "src/main.js",
      ],
      root,
    ),
    ["runtime/library.db", "nested/local.txt", "certs/server.pem"],
  );
});

test("falls back to the built-in path rules without a root .gitignore", (t) => {
  const root = temporaryRepository(t);

  assert.deepEqual(
    sensitivePaths(
      [
        ".privacy-blocklist",
        "data/notes.txt",
        "config/app.example.yml",
        "config/app.yml",
        ".env",
        ".env.example",
        "certs/server.pem",
        "src/main.js",
      ],
      root,
    ),
    [
      ".privacy-blocklist",
      "data/notes.txt",
      "config/app.yml",
      ".env",
      "certs/server.pem",
    ],
  );
});
