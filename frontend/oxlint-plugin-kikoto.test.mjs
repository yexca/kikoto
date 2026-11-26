import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { crossFeatureAllowance } from "./oxlint-plugin-kikoto.mjs";

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
      "kikoto/dependency-direction": "error",
      "kikoto/no-inline-skeleton": "error",
      "kikoto/no-direct-storage": "error",
    },
  }),
);

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

function lint(source) {
  const file = path.join(workspace, `case-${Math.random().toString(36).slice(2)}.tsx`);
  writeFileSync(file, `import { useCallback, useEffect, useLayoutEffect } from "react";\n${source}\n`);
  return run(file);
}

/** Lints `source` as the file at `relative` below a src/ directory. */
function lintAt(relative, source) {
  const file = path.join(workspace, `case-${Math.random().toString(36).slice(2)}`, "src", relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${source}\n`);
  return run(file);
}

function run(file) {
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

describe("kikoto dependency direction", () => {
  it("reports imports that run against app -> features -> shared -> components/ui", () => {
    expect(lintAt("lib/a.ts", `export { x } from "@/features/workflows/useLatestRun";`)).toEqual([
      "kikoto(dependency-direction)",
    ]);
    expect(lintAt("components/ui/a.tsx", `import { x } from "@/hooks/useX"; export const y = x;`)).toEqual([
      "kikoto(dependency-direction)",
    ]);
    expect(lintAt("features/rankings/a.tsx", `export const y = import("../workflows/runPresentation");`)).toEqual([
      "kikoto(dependency-direction)",
    ]);
    expect(lintAt("features/rankings/a.tsx", `import { x } from "@/app/navigation"; export const y = x;`)).toEqual([
      "kikoto(dependency-direction)",
    ]);
    expect(lintAt("player/dock/a.tsx", `export { x } from "../../pages/settingsPaths";`)).toEqual([
      "kikoto(dependency-direction)",
    ]);
  });

  it("accepts a feature's own modules, another feature's public entry, and pages composing features", () => {
    expect(
      lintAt(
        "features/rankings/a.tsx",
        `import { a } from "./parts/a"; import { b } from "@/features/proxy"; import { c } from "@/lib/c"; export const y = [a, b, c];`,
      ),
    ).toEqual([]);
    expect(lintAt("pages/a.tsx", `import { x } from "@/features/workflows/useLatestRun"; export const y = x;`)).toEqual(
      [],
    );
  });

  it("keeps every cross-feature allowance pointing at an import that still exists", () => {
    for (const [file, targets] of Object.entries(crossFeatureAllowance)) {
      const source = readFileSync(path.join(frontend, "src", file), "utf8");
      for (const target of targets) expect(source, `${file} -> ${target}`).toContain(`"@/${target}"`);
    }
  });
});

describe("kikoto inline skeleton", () => {
  it("reports a hand-styled placeholder in a literal or a template", () => {
    expect(
      lintAt(
        "features/a/a.tsx",
        'export const a = <div className="h-4 w-40 animate-pulse rounded bg-muted" />;\nexport const b = (w) => <div className={`animate-pulse rounded-full bg-foreground/10 ${w}`} />;',
      ),
    ).toEqual(["kikoto(no-inline-skeleton)", "kikoto(no-inline-skeleton)"]);
  });

  it("accepts a pulsing icon, a motion-safe progress pulse, and the primitive itself", () => {
    expect(
      lintAt(
        "features/a/a.tsx",
        'export const a = <i className="h-4 w-4 animate-pulse" />;\nexport const b = <div className="rounded-full bg-primary/70 motion-safe:animate-pulse" />;',
      ),
    ).toEqual([]);
    expect(
      lintAt("components/ui/skeleton.tsx", 'export const a = <div className="animate-pulse rounded bg-muted" />;'),
    ).toEqual([]);
  });
});

describe("kikoto direct storage", () => {
  it("reports browser storage reached as a global, through window, or by a computed name", () => {
    expect(
      lintAt(
        "features/a/a.ts",
        'export const a = localStorage.getItem("kikoto:a");\nexport const b = () => window.sessionStorage;\nexport const c = globalThis["localStorage"];\nexport const d = typeof sessionStorage;',
      ),
    ).toEqual([
      "kikoto(no-direct-storage)",
      "kikoto(no-direct-storage)",
      "kikoto(no-direct-storage)",
      "kikoto(no-direct-storage)",
    ]);
  });

  it("accepts the storage module itself and names that only look like storage", () => {
    expect(lintAt("lib/clientStorage.ts", "export const a = () => window.localStorage;")).toEqual([]);
    expect(
      lintAt(
        "features/a/a.ts",
        'import { localStore } from "@/lib/clientStorage";\nexport const a = { localStorage: 1 };\nexport const b = (event: StorageEvent) => event.storageArea;\nexport const c = localStore;',
      ),
    ).toEqual([]);
  });
});
