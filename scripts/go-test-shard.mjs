import {
  createWriteStream,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Runs one slice of the backend Go tests so several runners can share a suite
// that is serial inside each package. Every shard lists the same tests, and
// the slices partition them: each test runs in exactly one shard.

const packages = "./...";
const listed = /^(Test|Example|Fuzz)[\p{L}\p{N}_]*$/u;
// A single argument is limited to 128 KiB on Linux.
const maxPatternBytes = 100_000;
// Race-detector seconds per package and test, recorded by the CI slices and
// refreshed with `make RACE_RUN=<run id> backend-race-durations`.
const durationsFile = new URL("./go-test-durations.json", import.meta.url);
// The artifacts in which each CI slice uploads its `go test -json` events.
const eventsArtifacts = "backend-race-events-*";
// Packages of one `go test` run in parallel up to the CPU count of the runner,
// which is the same on every shard. A fixed value keeps every shard, and a
// local run, computing the same partition.
const runnerParallelism = 4;

export function parseShard(value) {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value ?? "");
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || index > total)
    throw new Error(`Shard must be <index>/<total>, such as 1/4: ${value}`);
  return { index, total };
}

// Reads `go test -json -list` output into a package -> test names map.
export function parseTestList(output) {
  const tests = new Map();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const name = event.Output?.trim();
    if (event.Action !== "output" || !event.Package || !listed.test(name))
      continue;
    if (!tests.has(event.Package)) tests.set(event.Package, new Set());
    tests.get(event.Package).add(name);
  }
  return tests;
}

// Reads `go test -json` run output into package -> test -> seconds. Subtests
// count toward their top-level test. A failed run is refused, because its
// timings stop at the failure.
export function parseDurations(output) {
  const durations = {};
  const failed = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.Action === "fail")
      failed.push(
        event.Test ? `${event.Package} ${event.Test}` : event.Package,
      );
    if (
      event.Action !== "pass" ||
      !event.Package ||
      !listed.test(event.Test ?? "")
    )
      continue;
    durations[event.Package] ??= {};
    durations[event.Package][event.Test] =
      Math.round((event.Elapsed ?? 0) * 100) / 100;
  }
  if (failed.length)
    throw new Error(`Refusing durations from a failed run: ${failed[0]}`);
  return sortKeys(
    Object.fromEntries(
      Object.entries(durations).map(([pkg, tests]) => [pkg, sortKeys(tests)]),
    ),
  );
}

function sortKeys(object) {
  return Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The time a shard needs. `go test` starts its packages in import path order,
// each as soon as one of the runner's slots is free, and runs the tests of a
// package one after another; the recorded durations already include the
// slowdown of sharing the CPUs.
export function shardSeconds(packageSeconds) {
  const slots = Array(runnerParallelism).fill(0);
  for (const pkg of [...packageSeconds.keys()].sort()) {
    const next = slots.indexOf(Math.min(...slots));
    slots[next] += packageSeconds.get(pkg);
  }
  return Math.max(...slots);
}

// Places the names on shards by recorded duration, longest first, each on the
// shard that would then finish soonest. Tests run serially inside a package,
// so a shard is never faster than its slowest package; this spreads each
// heavy package as well as the total. A test without a recording costs the median of
// its package. A name is placed once: the single -run pattern applies to every
// package, so its cost is the sum over the packages that declare it.
export function selectShard(tests, { index, total }, durations = {}) {
  const everyRecording = Object.values(durations).flatMap((recorded) =>
    Object.values(recorded),
  );
  const fallback = median(everyRecording) ?? 1;
  const costs = new Map();
  let unrecorded = 0;
  for (const pkg of [...tests.keys()].sort()) {
    const recorded = durations[pkg] ?? {};
    const packageFallback = median(Object.values(recorded)) ?? fallback;
    for (const name of [...tests.get(pkg)].sort()) {
      if (!costs.has(name)) costs.set(name, new Map());
      if (!Object.hasOwn(recorded, name)) unrecorded++;
      costs.get(name).set(pkg, recorded[name] ?? packageFallback);
    }
  }
  const order = [...costs]
    .map(([name, packageCosts]) => ({
      name,
      packageCosts,
      seconds: [...packageCosts.values()].reduce((sum, cost) => sum + cost, 0),
    }))
    .sort(
      (a, b) =>
        b.seconds - a.seconds ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  const shards = Array.from({ length: total }, () => ({
    packages: new Map(),
    seconds: 0,
    total: 0,
  }));
  const owner = new Map();
  for (const unit of order) {
    let best = null;
    for (const [position, shard] of shards.entries()) {
      const packages = new Map(shard.packages);
      for (const [pkg, cost] of unit.packageCosts)
        packages.set(pkg, (packages.get(pkg) ?? 0) + cost);
      const candidate = {
        position,
        packages,
        seconds: shardSeconds(packages),
        total: shard.total + unit.seconds,
      };
      if (
        !best ||
        candidate.seconds < best.seconds ||
        (candidate.seconds === best.seconds && candidate.total < best.total)
      )
        best = candidate;
    }
    const shard = shards[best.position];
    shard.packages = best.packages;
    shard.seconds = best.seconds;
    shard.total = best.total;
    owner.set(unit.name, best.position);
  }
  const names = [...costs.keys()].filter(
    (name) => owner.get(name) === index - 1,
  );
  const selected = new Set(names);
  const shard = shards[index - 1];
  return {
    names,
    count: costs.size,
    unrecorded,
    seconds: shard.seconds,
    packages: [...tests.keys()]
      .sort()
      .filter((pkg) => [...tests.get(pkg)].some((name) => selected.has(name))),
  };
}

export function runPattern(names) {
  const pattern = `^(${names.join("|")})$`;
  if (Buffer.byteLength(pattern) > maxPatternBytes)
    throw new Error(
      "The test name pattern is too long for one argument; use more shards.",
    );
  return pattern;
}

// Prints a `go test -json` stream the way `go test` prints it without -v: the
// result line of each passing package, the whole output of a failing one, and
// build errors.
export function createReporter(write) {
  const outputs = new Map();
  return (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      if (line.trim()) write(`${line}\n`);
      return;
    }
    if (event.Action === "build-output") return write(event.Output ?? "");
    if (!event.Package) return;
    const output = outputs.get(event.Package) ?? { lines: [], summary: "" };
    outputs.set(event.Package, output);
    if (event.Action === "output") {
      output.lines.push(event.Output ?? "");
      if (!event.Test) output.summary = event.Output ?? "";
      return;
    }
    if (event.Test || !["pass", "fail", "skip"].includes(event.Action)) return;
    outputs.delete(event.Package);
    write(event.Action === "fail" ? output.lines.join("") : output.summary);
  };
}

function readDurations() {
  try {
    return JSON.parse(readFileSync(durationsFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function gh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`gh ${args.join(" ")} exited with ${result.status}`);
  return result.stdout;
}

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

// Writes the durations that the race slices of a successful CI run uploaded.
function record(run, path) {
  if (!/^\d+$/.test(run ?? "") || !path)
    throw new Error("usage: go-test-shard.mjs record <run id> <file>");
  const conclusion = gh([
    "run",
    "view",
    run,
    "--json",
    "conclusion",
    "--jq",
    ".conclusion",
  ]).trim();
  if (conclusion !== "success")
    throw new Error(
      `Run ${run} did not succeed: ${conclusion || "in progress"}`,
    );
  const directory = mkdtempSync(join(tmpdir(), "kikoto-race-events-"));
  try {
    gh([
      "run",
      "download",
      run,
      "--pattern",
      eventsArtifacts,
      "--dir",
      directory,
    ]);
    const files = filesUnder(directory);
    const durations = parseDurations(
      files.map((file) => readFileSync(file, "utf8")).join("\n"),
    );
    if (!Object.keys(durations).length)
      throw new Error("The artifacts hold no passed tests.");
    writeFileSync(path, `${JSON.stringify(durations, null, 2)}\n`);
    const count = Object.values(durations).reduce(
      (sum, tests) => sum + Object.keys(tests).length,
      0,
    );
    console.log(
      `Recorded ${count} test durations from ${files.length} slices of run ${run} in ${path}.`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// Runs the selected tests, printing them as `go test` does and, when
// GO_TEST_JSON names a file, keeping their events there for `record`.
async function run(args) {
  const events = process.env.GO_TEST_JSON
    ? createWriteStream(process.env.GO_TEST_JSON)
    : null;
  const child = spawn("go", ["test", "-json", ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  const report = createReporter((text) => process.stdout.write(text));
  for await (const line of createInterface({ input: child.stdout })) {
    events?.write(`${line}\n`);
    report(line);
  }
  const code = await exited;
  if (events) await new Promise((resolve) => events.end(resolve));
  return code;
}

async function main() {
  const [shardArg, ...flags] = process.argv.slice(2);
  if (shardArg === "record") return record(flags[0], flags[1]);
  const shard = parseShard(shardArg);
  const list = spawnSync(
    "go",
    ["test", "-json", "-list", "^(Test|Example|Fuzz)", ...flags, packages],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (list.error) throw list.error;
  if (list.status !== 0) {
    // A package that does not build fails the listing; show the compiler output.
    for (const line of list.stdout.split("\n")) {
      try {
        const output = JSON.parse(line).Output;
        if (output) process.stderr.write(output);
      } catch {
        // Not an event line.
      }
    }
    process.exit(list.status ?? 1);
  }
  const selection = selectShard(
    parseTestList(list.stdout),
    shard,
    readDurations(),
  );
  console.log(
    `Shard ${shard.index}/${shard.total}: ${selection.names.length} of ${selection.count} tests in ${selection.packages.length} packages, about ${Math.round(selection.seconds)}s by recorded durations.`,
  );
  if (selection.unrecorded)
    console.log(
      `${selection.unrecorded} tests have no recorded duration; refresh them with make backend-race-durations.`,
    );
  if (!selection.names.length) return;
  process.exit(
    await run([
      ...flags,
      "-run",
      runPattern(selection.names),
      ...selection.packages,
    ]),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
