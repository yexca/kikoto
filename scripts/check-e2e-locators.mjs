import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Guards the Playwright suite against the two patterns that agents copy from
// neighbouring specs: fixed sleeps, and locators that select by CSS class.
// docs/development/testing.md#assertions-and-locators says what to use instead.

const repositoryRoot = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const testsRoot = path.join(repositoryRoot, "frontend", "tests");

const sleepMessage =
  "waitForTimeout is a fixed sleep; wait on observable state with expect or expect.poll, or advance page.clock for time-driven behavior";
const classMessage =
  "locator selects by CSS class; use a role, label, test id, or an authored data- marker";

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : walk(absolute);
    return entry.name.endsWith(".ts") ? [absolute] : [];
  });
}

/** True when `index` sits after a line comment opener on its own line. */
function inLineComment(source, index) {
  const lineStart = source.lastIndexOf("\n", index - 1) + 1;
  return /(^|\s)\/\/|^\s*(\/?\*)/u.test(source.slice(lineStart, index));
}

function lineOf(source, index) {
  let line = 1;
  for (let at = source.indexOf("\n"); at !== -1 && at < index;) {
    line += 1;
    at = source.indexOf("\n", at + 1);
  }
  return line;
}

/**
 * Reads the string literal that opens at `start`, with each template
 * placeholder replaced by `_` so interpolated code never reads as a selector.
 */
function readLiteral(source, start) {
  const quote = source[start];
  let text = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      text += source.slice(index, index + 2);
      index += 1;
    } else if (char === quote) {
      return text;
    } else if (quote === "`" && char === "$" && source[index + 1] === "{") {
      let depth = 0;
      do {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") depth -= 1;
        index += 1;
      } while (depth > 0 && index < source.length);
      index -= 1;
      text += "_";
    } else {
      text += char;
    }
  }
  return null;
}

/** Whether a Playwright selector string matches elements by their class. */
export function selectsByClass(selector) {
  const trimmed = selector.trim();
  const engine = /^([a-z-]+)=/iu.exec(trimmed)?.[1]?.toLowerCase();
  if (
    engine === "xpath" ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("..")
  ) {
    return /@class\b/u.test(trimmed);
  }
  if (engine && engine !== "css") return false;
  const css = engine ? trimmed.slice(engine.length + 1) : trimmed;
  if (/\[\s*class\s*[~|^$*]?=/u.test(css)) return true;
  // Quoted values are attribute values or :has-text arguments, never classes.
  const structure = css
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu, '""')
    .replace(/\[[^\]]*\]/gu, "[]");
  return /\.-?[_a-z]/iu.test(structure);
}

/** Every fixed sleep and class-based locator in a spec, with its line. */
export function violations(source) {
  const found = [];
  for (const match of source.matchAll(/\bwaitForTimeout\s*\(/gu)) {
    if (inLineComment(source, match.index)) continue;
    found.push({ line: lineOf(source, match.index), message: sleepMessage });
  }
  for (const match of source.matchAll(/\.locator\(\s*(?=["'`])/gu)) {
    if (inLineComment(source, match.index)) continue;
    const selector = readLiteral(source, match.index + match[0].length);
    if (selector !== null && selectsByClass(selector)) {
      found.push({ line: lineOf(source, match.index), message: classMessage });
    }
  }
  return found.sort((left, right) => left.line - right.line);
}

export function scan(root) {
  return walk(root).flatMap((file) =>
    violations(fs.readFileSync(file, "utf8")).map((violation) => ({
      file: path.relative(repositoryRoot, file).replaceAll("\\", "/"),
      ...violation,
    })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scan(testsRoot);
  if (found.length > 0) {
    console.error(
      `Found ${found.length} fixed sleep${found.length === 1 ? "" : "s"} or class-based locator${found.length === 1 ? "" : "s"} in frontend/tests.`,
    );
    for (const { file, line, message } of found)
      console.error(`- ${file}:${line}: ${message}`);
    console.error(
      "See docs/development/testing.md#assertions-and-locators for what to use instead.",
    );
    process.exitCode = 1;
  } else {
    console.log("Checked frontend/tests for fixed sleeps and class locators.");
  }
}
