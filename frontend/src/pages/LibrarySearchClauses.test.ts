import { describe, expect, it } from "vitest";

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
