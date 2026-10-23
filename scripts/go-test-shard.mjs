import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Runs one slice of the backend Go tests so several runners can share a suite
// that is serial inside each package. Every shard lists the same tests, and
// the slices partition them: each test runs in exactly one shard.

const packages = "./...";
const listed = /^(Test|Example|Fuzz)[\p{L}\p{N}_]*$/u;
// A single argument is limited to 128 KiB on Linux.
const maxPatternBytes = 100_000;
// Recorded race-detector seconds per package and test, refreshed with
// `make backend-race-durations`.
const durationsFile = new URL("./go-test-durations.json", import.meta.url);
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

// The time a shard needs: its longest package runs serially, and all of its
// packages share the runner's CPUs.
function shardSeconds(longest, total) {
  return Math.max(longest, total / runnerParallelism);
}

// Places the names on shards by recorded duration, longest first, each on the
// shard that would then finish soonest. Tests run serially inside a package,
// so a shard is only as fast as its slowest package; this spreads each heavy
// package as well as the total. A test without a recording costs the median of
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
    longest: 0,
    total: 0,
  }));
  const owner = new Map();
  for (const unit of order) {
    let best = null;
    for (const [position, shard] of shards.entries()) {
      let longest = shard.longest;
      for (const [pkg, cost] of unit.packageCosts)
        longest = Math.max(longest, (shard.packages.get(pkg) ?? 0) + cost);
      const candidate = {
        position,
        longest,
        seconds: shardSeconds(longest, shard.total + unit.seconds),
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
    for (const [pkg, cost] of unit.packageCosts)
      shard.packages.set(pkg, (shard.packages.get(pkg) ?? 0) + cost);
    shard.longest = best.longest;
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
    seconds: shardSeconds(shard.longest, shard.total),
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

function readDurations() {
  try {
    return JSON.parse(readFileSync(durationsFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

// Writes the durations of a `go test -json` run read from stdin.
function record(path) {
  if (!path)
    throw new Error(
      "usage: go test -json ... | go-test-shard.mjs record <file>",
    );
  const durations = parseDurations(readFileSync(0, "utf8"));
  if (!Object.keys(durations).length)
    throw new Error("The input holds no passed tests.");
  writeFileSync(path, `${JSON.stringify(durations, null, 2)}\n`);
  const count = Object.values(durations).reduce(
    (sum, tests) => sum + Object.keys(tests).length,
    0,
  );
  console.log(`Recorded ${count} test durations in ${path}.`);
}

function main() {
  const [shardArg, ...flags] = process.argv.slice(2);
  if (shardArg === "record") return record(flags[0]);
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
  const run = spawnSync(
    "go",
    [
      "test",
      ...flags,
      "-run",
      runPattern(selection.names),
      ...selection.packages,
    ],
    { stdio: "inherit" },
  );
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
