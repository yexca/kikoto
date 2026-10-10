import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Runs one slice of the backend Go tests so several runners can share a suite
// that is serial inside each package. Every shard lists the same tests, and
// the slices partition them: each test runs in exactly one shard.

const packages = "./...";
const listed = /^(Test|Example|Fuzz)[\p{L}\p{N}_]*$/u;
// A single argument is limited to 128 KiB on Linux.
const maxPatternBytes = 100_000;

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

// Deals the names out in package order, so each package's tests, and the
// similarly named ones that tend to cost the same, spread over all shards. A
// name is dealt once: the single -run pattern applies to every package.
export function selectShard(tests, { index, total }) {
  const owner = new Map();
  for (const pkg of [...tests.keys()].sort())
    for (const name of [...tests.get(pkg)].sort())
      if (!owner.has(name)) owner.set(name, owner.size % total);
  const names = [...owner.keys()].filter(
    (name) => owner.get(name) === index - 1,
  );
  const selected = new Set(names);
  return {
    names,
    count: owner.size,
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

function main() {
  const [shardArg, ...flags] = process.argv.slice(2);
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
  const selection = selectShard(parseTestList(list.stdout), shard);
  console.log(
    `Shard ${shard.index}/${shard.total}: ${selection.names.length} of ${selection.count} tests in ${selection.packages.length} packages.`,
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
