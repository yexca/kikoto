import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

// The rules run inside Oxlint's JS plugin host, so they are checked through
// the real binary: a host change that stops them reporting fails here.
const frontend = path.dirname(fileURLToPath(import.meta.url));
const workspace = mkdtempSync(path.join(tmpdir(), "kikoto-oxlint-"));
const config = path.join(workspace, ".oxlintrc.json");
writeFileSync(
  config,
  JSON.stringify({
    plugins: ["react"],
    jsPlugins: [path.join(frontend, "oxlint-plugin-kikoto.mjs").replaceAll("\\", "/")],
    rules: {
      "kikoto/no-effect-cancel-flag": "error",
      "kikoto/no-effect-abort-controller": "error",
    },
  }),
);

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function lint(source) {
  const file = path.join(workspace, `case-${Math.random().toString(36).slice(2)}.tsx`);
  writeFileSync(file, `import { useCallback, useEffect, useLayoutEffect } from "react";\n${source}\n`);
  const binary = path.join(frontend, "node_modules", "oxlint", "bin", "oxlint");
  let output;
  try {
    output = execFileSync(process.execPath, [binary, "-c", config, "--format", "json", file], { encoding: "utf8" });
  } catch (error) {
    output = error.stdout;
  }
  return JSON.parse(output)
    .diagnostics.map((diagnostic) => diagnostic.code)
    .filter((code) => code.startsWith("kikoto("))
    .sort();
}

describe("kikoto Oxlint rules", () => {
  it("reports a flag the effect cleanup flips", () => {
    expect(
      lint(`export function A({ load, set }) {
  useLayoutEffect(() => {
    let disposed = false;
    load().then((value) => { if (!disposed) set(value); });
    const cleanup = () => { disposed = true; };
    return cleanup;
  }, [load, set]);
}`),
    ).toEqual(["kikoto(no-effect-cancel-flag)"]);
  });

  it("reports an AbortController the effect creates, also in a nested refresh", () => {
    expect(
      lint(`export function A({ load }) {
  useEffect(() => {
    const refresh = () => {
      const controller = new AbortController();
      void load(controller.signal);
    };
    refresh();
  }, [load]);
}`),
    ).toEqual(["kikoto(no-effect-abort-controller)"]);
  });

  it("accepts the shared helpers and a request a user action starts", () => {
    expect(
      lint(`import { startLoad } from "@/lib/effectScope";
export function A({ load, set }) {
  useEffect(() => startLoad((signal) => load(signal), { onSuccess: set }), [load, set]);
  const run = useCallback(() => {
    const controller = new AbortController();
    void load(controller.signal);
    let done = false;
    return () => { done = true; };
  }, [load]);
  return run;
}`),
    ).toEqual([]);
  });
});
