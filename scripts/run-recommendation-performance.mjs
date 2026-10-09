import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = new Set();
const args = process.argv.slice(2);
let baseline;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--baseline" || args[1].startsWith("-"))
    throw new Error("expected --baseline <git-ref>");
  baseline = args[1];
}
function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      windowsHide: true,
    });
    children.add(child);
    child.once("error", reject);
    child.once("exit", (code) => {
      children.delete(child);
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`));
    });
  });
}
function cleanupChildren() {
  for (const child of children) child.kill();
}
process.once("exit", cleanupChildren);
process.once("SIGINT", () => {
  cleanupChildren();
  process.exitCode = 130;
});
const testArgs = [
  "test",
  "./internal/library",
  "-run",
  "^TestRecommendationScalePerformance$",
  "-count=1",
  "-v",
  "-timeout=45m",
];
const environment = { KIKOTO_RECOMMENDATION_PERF: "1" };
let temporary;
try {
  console.log(
    `hardware os=${os.platform()} ${os.release()} arch=${os.arch()} cpu=${os.cpus()[0]?.model} logical_cpus=${os.cpus().length} node=${process.version}`,
  );
  await run(process.env.GO || "go", ["version"], root);
  if (baseline) {
    temporary = await mkdtemp(
      path.join(os.tmpdir(), "kikoto-recommendation-perf-"),
    );
    const archive = path.join(temporary, "baseline.tar");
    const checkout = path.join(temporary, "baseline");
    await mkdir(checkout);
    console.log(`revision baseline=${baseline}`);
    await run("git", ["rev-parse", "--verify", `${baseline}^{commit}`], root);
    await run("git", ["archive", `--output=${archive}`, baseline], root);
    await run("tar", ["-xf", archive, "-C", checkout], root);
    for (const file of [
      "backend/internal/library/recommendation_scale_performance_test.go",
      "backend/internal/testfixture/recommendation_scale.go",
      "backend/internal/testfixture/work_code.go",
    ])
      await cp(path.join(root, file), path.join(checkout, file));
    await run(
      process.env.GO || "go",
      testArgs,
      path.join(checkout, "backend"),
      environment,
    );
  }
  console.log("revision candidate=working-tree");
  await run(
    process.env.GO || "go",
    testArgs,
    path.join(root, "backend"),
    environment,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  cleanupChildren();
  if (temporary) {
    const resolved = path.resolve(temporary);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("kikoto-recommendation-perf-")
    )
      throw new Error(
        "refusing cleanup outside the owned temporary experiment directory",
      );
    await rm(resolved, { recursive: true, force: true });
  }
}
