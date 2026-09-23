import assert from "node:assert/strict";
import test from "node:test";

import {
  parseApprovedEndpointAllowlist,
  scanLine,
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
