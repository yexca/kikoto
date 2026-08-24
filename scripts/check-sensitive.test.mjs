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

function approvedAllowlist() {
  return parseApprovedEndpointAllowlist(
    JSON.stringify({
      version: 1,
      endpoints: [
        {
          url: approvedEndpoint(),
          files: [ownerFile],
          reason: "Test-only approved public endpoint.",
        },
      ],
    }),
  );
}

test("allows only the exact public npm registry host", () => {
  const registryHost = ["registry", "npmjs", "org"].join(".");
  const findings = [];

  scanLine(
    {
      file: "frontend/package-lock.json",
      line: 1,
      text: `"resolved": "${endpointFor(registryHost)}package.tgz"`,
    },
    findings,
    new Map(),
  );
  assert.deepEqual(findings, []);

  scanLine(
    {
      file: "frontend/package-lock.json",
      line: 2,
      text: `"resolved": "${endpointFor(`mirror.${registryHost}`)}package.tgz"`,
    },
    findings,
    new Map(),
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "non-reserved service URL");
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
