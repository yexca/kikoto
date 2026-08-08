import { describe, expect, it } from "vitest";

import { syntheticWorkCode } from "@/test-support/workCode";
import { compileLibrarySearchQuery, formatRemoteSearchQuery, parseSearchClauses } from "./librarySearchClauses";

describe("Library shelf search clause", () => {
  it("parses and compiles shelf membership for the local library", () => {
    const clauses = parseSearchClauses("shelf:true tag:Example");

    expect(clauses).toContainEqual({ kind: "shelf", value: "true" });
    expect(compileLibrarySearchQuery(clauses)).toContain("shelf:true");
  });

  it("does not send the local-only shelf clause to remote sources", () => {
    const clauses = parseSearchClauses("shelf:true tag:Example");

    expect(formatRemoteSearchQuery(clauses)).toBe("$tag:Example$");
  });
});

describe("Library work-code search clause", () => {
  it.each(["RJ", "BJ", "VJ", "CC"] as const)("recognizes the supported %s prefix", (prefix) => {
    const code = syntheticWorkCode(prefix, 0);
    expect(parseSearchClauses(code.toLowerCase())).toEqual([{ kind: "code", value: code }]);
  });

  it("treats a four-digit work code as text", () => {
    expect(parseSearchClauses("RJ0000")).toEqual([{ kind: "text", value: "RJ0000" }]);
  });
});
