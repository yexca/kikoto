import { describe, expect, it } from "vitest";

import { resources } from "@/i18n/resources/all";

// A key that no resource defines renders as the key itself, or as its inline
// English default in every locale. Locale parity cannot see this, because every
// locale is missing the same key.
const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/i18n/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const english = resources.en.translation as Record<string, unknown>;
const pluralSuffixes = ["zero", "one", "two", "few", "many", "other"];

function lookup(key: string): unknown {
  let node: unknown = english;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function defined(key: string) {
  return lookup(key) !== undefined || pluralSuffixes.some((suffix) => lookup(`${key}_${suffix}`) !== undefined);
}

/** Keys written as a complete string literal at a translation call or `i18nKey`. */
function literalKeys(source: string) {
  const keys = new Set<string>();
  for (const match of source.matchAll(/(?<![\w$.])(?:i18n\.)?t\(\s*(["'`])([\w.-]+)\1/gu)) keys.add(match[2]);
  for (const match of source.matchAll(/\bi18nKey=(["'])([\w.-]+)\1/gu)) keys.add(match[2]);
  return keys;
}

/** Sections addressed through a literal prefix, such as `t(\`section.${value}\`)`. */
function templateSections(source: string) {
  const sections = new Set<string>();
  for (const match of source.matchAll(/(?<![\w$.])(?:i18n\.)?t\(\s*`([\w.-]+)\.\$\{/gu)) sections.add(match[1]);
  return sections;
}

describe("translation keys used by the application", () => {
  it("are all defined in the resources", () => {
    const missing: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      for (const key of literalKeys(source)) if (!defined(key)) missing.push(`${file}: ${key}`);
      for (const section of templateSections(source)) {
        const node = lookup(section);
        if (!node || typeof node !== "object") missing.push(`${file}: ${section}.*`);
      }
    }
    expect(missing.sort()).toEqual([]);
  });
});
