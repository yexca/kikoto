import assert from "node:assert/strict";
import test from "node:test";
import {
  parseDurations,
  parseShard,
  parseTestList,
  runPattern,
  selectShard,
} from "./go-test-shard.mjs";

const event = (pkg, output, action = "output") =>
  JSON.stringify({ Action: action, Package: pkg, Output: output });

test("only well-formed shard selectors are accepted", () => {
  assert.deepEqual(parseShard("1/1"), { index: 1, total: 1 });
  assert.deepEqual(parseShard("3/4"), { index: 3, total: 4 });
  for (const value of [undefined, "", "0/4", "5/4", "1/0", "1", "a/b", "1/4/2"])
    assert.throws(() => parseShard(value), String(value));
});

test("the listing keeps tests, examples and fuzz targets per package and ignores everything else", () => {
  const tests = parseTestList(
    [
      event("example/a", "TestOne\n"),
      event("example/a", "ExampleTwo\n"),
      event("example/a", "FuzzThree\n"),
      event("example/a", "BenchmarkFour\n"),
      event("example/a", "ok  \texample/a\t0.010s\n"),
      event("example/a", "TestOne\n", "pass"),
      event("example/b", "TestFive\n"),
      event("example/c", "?   \texample/c\t[no test files]\n"),
      "not json",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    [...tests].map(([pkg, names]) => [pkg, [...names]]),
    [
      ["example/a", ["TestOne", "ExampleTwo", "FuzzThree"]],
      ["example/b", ["TestFive"]],
    ],
  );
});

test("shards partition every listed test and, without recordings, spread each package", () => {
  const tests = new Map([
    ["example/b", new Set(["TestB1", "TestB2", "TestB3", "TestShared"])],
    [
      "example/a",
      new Set(Array.from({ length: 9 }, (_, index) => `TestA${index}`)),
    ],
    ["example/c", new Set(["TestShared", "TestC1"])],
  ]);
  const all = new Set([...tests.values()].flatMap((names) => [...names]));
  const durations = {
    "example/a": { TestA0: 9, TestA3: 0.5 },
    "example/c": { TestShared: 4 },
  };
  for (const recorded of [{}, durations])
    for (const total of [1, 2, 3, 4, 7, 20]) {
      const seen = [];
      for (let index = 1; index <= total; index++) {
        const selection = selectShard(tests, { index, total }, recorded);
        assert.equal(selection.count, all.size);
        seen.push(...selection.names);
        for (const pkg of selection.packages)
          assert.ok(selection.names.some((name) => tests.get(pkg).has(name)));
        for (const [pkg, names] of tests) {
          const selected = selection.names.some((name) => names.has(name));
          assert.equal(selection.packages.includes(pkg), selected);
        }
      }
      assert.equal(seen.length, all.size, `total ${total}`);
      assert.deepEqual(new Set(seen), all, `total ${total}`);
    }
  const shares = [1, 2, 3].map(
    (index) =>
      selectShard(tests, { index, total: 3 }).names.filter((name) =>
        name.startsWith("TestA"),
      ).length,
  );
  assert.deepEqual(shares, [3, 3, 3]);
});

test("recorded durations give a slow test's package room on its own shard", () => {
  const tests = new Map([
    [
      "example/a",
      new Set([
        "TestSlow",
        ...Array.from({ length: 6 }, (_, i) => `TestA${i}`),
      ]),
    ],
    ["example/b", new Set(["TestB1", "TestB2"])],
  ]);
  const durations = {
    "example/a": { TestSlow: 10, TestA0: 1, TestA1: 1, TestA2: 1, TestA3: 1 },
    "example/b": { TestB1: 5, TestB2: 5 },
  };
  const first = selectShard(tests, { index: 1, total: 2 }, durations);
  const second = selectShard(tests, { index: 2, total: 2 }, durations);
  assert.deepEqual(first.names, ["TestSlow"]);
  assert.equal(first.seconds, 10);
  assert.equal(second.names.length, 8);
  assert.equal(second.seconds, 10);
  // TestA4 and TestA5 have no recording and cost their package's median.
  assert.equal(first.unrecorded, 2);
});

test("durations come from passed top-level tests of a run that did not fail", () => {
  const run = (action, pkg, name, elapsed) =>
    JSON.stringify({
      Action: action,
      Package: pkg,
      Test: name,
      Elapsed: elapsed,
    });
  assert.deepEqual(
    parseDurations(
      [
        run("run", "example/b", "TestTwo"),
        run("pass", "example/b", "TestTwo", 2.345),
        run("pass", "example/b", "TestTwo/case", 1.2),
        run("skip", "example/b", "TestSkipped", 0),
        run("pass", "example/a", "TestOne", 0.004),
        JSON.stringify({ Action: "pass", Package: "example/a", Elapsed: 3 }),
        "not json",
      ].join("\n"),
    ),
    { "example/a": { TestOne: 0 }, "example/b": { TestTwo: 2.35 } },
  );
  assert.throws(
    () =>
      parseDurations(
        [
          run("pass", "example/a", "TestOne", 1),
          run("fail", "example/a", "TestTwo", 1),
        ].join("\n"),
      ),
    /failed run/,
  );
});

test("the run pattern anchors the names and refuses an oversized argument", () => {
  assert.equal(runPattern(["TestOne", "ExampleTwo"]), "^(TestOne|ExampleTwo)$");
  assert.throws(() =>
    runPattern(Array.from({ length: 10000 }, (_, index) => `TestName${index}`)),
  );
});
