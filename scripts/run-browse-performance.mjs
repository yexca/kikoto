import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const frontend = path.join(root, "frontend");
const mode = process.argv[2];
const children = new Set();
function start(command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    windowsHide: true,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function run(command, args, cwd, env) {
  const child = start(command, args, cwd, env);
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
const cleanup = () => {
  for (const child of children) child.kill();
};
process.once("exit", cleanup);
process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
try {
  if (mode === "sql") {
    await run(
      process.env.GO || "go",
      [
        "test",
        "-p=1",
        "./internal/library",
        "./internal/httpapi",
        "-run",
        "^(TestLibraryPagePerformance|TestBrowseMatrixPerformance|TestWorkCodeHTTPPerformance)$",
        "-count=1",
        "-v",
      ],
      path.join(root, "backend"),
      { KIKOTO_BROWSE_PERF: "1" },
    );
  } else if (mode === "playback") {
    await run(
      process.env.GO || "go",
      [
        "test",
        "./internal/httpapi",
        "-run",
        "^TestPlaybackStartupPerformance$",
        "-count=1",
        "-v",
      ],
      path.join(root, "backend"),
      { KIKOTO_PLAYBACK_PERF: "1", KIKOTO_PERF_FRONTEND: frontend },
    );
  } else if (mode === "browser") {
    const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3102";
    if (!process.env.PLAYWRIGHT_BASE_URL) {
      const preview = start(
        process.execPath,
        [
          "node_modules/vite/bin/vite.js",
          "preview",
          "--host",
          "127.0.0.1",
          "--port",
          "3102",
          "--strictPort",
        ],
        frontend,
      );
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (preview.exitCode !== null)
          throw new Error("production preview exited before readiness");
        try {
          ready = (await fetch(baseURL)).ok;
        } catch {
          /* wait for the owned preview */
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!ready) throw new Error("production preview did not become ready");
    }
    await run(
      process.execPath,
      [
        "node_modules/@playwright/test/cli.js",
        "test",
        "tests/e2e/browse-production-performance.spec.ts",
        "--project=desktop-chromium",
        "--workers=1",
      ],
      frontend,
      { PLAYWRIGHT_BASE_URL: baseURL, KIKOTO_PRODUCTION_PERF: "1" },
    );
  } else {
    throw new Error("expected sql, browser or playback");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  cleanup();
}
