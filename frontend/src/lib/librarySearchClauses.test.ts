import { describe, expect, it } from "vitest";

import { syntheticWorkCode } from "@/test-support/workCode";
import {
  compileLibrarySearchQuery,
  formatRemoteSearchQuery,
  formatSearchClause,
  normalizeSearchClauseDraft,
  parseSearchClauses,
} from "./librarySearchClauses";

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

describe("Library structured search clauses", () => {
  it("preserves quoted filter values and maps the supported local filter vocabulary", () => {
    expect(
      parseSearchClauses(
        'circle:"Example Circle" va:"Example Voice" tag:calm -tag:noise mytag:favorites -mytag:archive rating:4.5 sales:100 duration:600 -duration:3600 age:all lang:en shelf:false',
      ),
    ).toEqual([
      { kind: "circle", value: "Example Circle" },
      { kind: "voice_actor", value: "Example Voice" },
      { kind: "tag", value: "calm" },
      { kind: "exclude_tag", value: "noise" },
      { kind: "user_tag", value: "favorites" },
      { kind: "exclude_user_tag", value: "archive" },
      { kind: "rating_min", value: "4.5" },
      { kind: "sales_min", value: "100" },
      { kind: "duration_min", value: "600" },
      { kind: "duration_max", value: "3600" },
      { kind: "age", value: "all" },
      { kind: "language", value: "en" },
      { kind: "shelf", value: "false" },
    ]);
  });

  it("normalizes draft values and emits stable local query syntax", () => {
    expect(normalizeSearchClauseDraft({ kind: "text", value: "  " })).toBeNull();
    expect(normalizeSearchClauseDraft({ kind: "code", value: " rj00000000 " })).toEqual({
      kind: "code",
      value: "RJ00000000",
    });
    expect(normalizeSearchClauseDraft({ kind: "shelf", value: "unexpected" })).toEqual({
      kind: "shelf",
      value: "true",
    });
    expect(
      compileLibrarySearchQuery([
        { kind: "circle", value: "Example Circle" },
        { kind: "exclude_tag", value: "noise" },
        { kind: "duration_max", value: "3600" },
      ]),
    ).toBe("$circle:Example Circle$ $-tag:noise$ $-duration:3600$");
  });

  it("treats a leading minus as exclusion on every circle and voice key", () => {
    const clauses = parseSearchClauses(
      '-circle:"Example Circle" -va:"Example Voice" -voice:Second -creator: Third $-va:Wrapped Voice$ $-circle:Wrapped Circle$',
    );

    expect(clauses).toEqual([
      { kind: "exclude_voice_actor", value: "Wrapped Voice" },
      { kind: "exclude_circle", value: "Wrapped Circle" },
      { kind: "exclude_circle", value: "Example Circle" },
      { kind: "exclude_voice_actor", value: "Example Voice" },
      { kind: "exclude_voice_actor", value: "Second" },
      { kind: "exclude_voice_actor", value: "Third" },
    ]);
    expect(clauses.map((clause) => clause.kind)).not.toContain("voice_actor");
    expect(clauses.map((clause) => clause.kind)).not.toContain("text");
  });

  it("sends exclusions to the library and to remote sources in the server's negated syntax", () => {
    const clauses = parseSearchClauses('-circle:"Example Circle" -va:"Example Voice" -mytag:"Sleep aid"');

    expect(compileLibrarySearchQuery(clauses)).toBe("$-circle:Example Circle$ $-va:Example Voice$ $-mytag:Sleep aid$");
    expect(formatRemoteSearchQuery(clauses)).toBe('$-circle:Example Circle$ $-va:Example Voice$ -mytag:"Sleep aid"');
    expect(clauses.map(formatSearchClause).join(" ")).toBe(
      '-circle:"Example Circle" -va:"Example Voice" -mytag:"Sleep aid"',
    );
  });

  it("keeps a quoted phrase as one needle through parsing and every outgoing query", () => {
    const clauses = parseSearchClauses('"calm night" rain');

    expect(clauses).toEqual([
      { kind: "text", value: "calm night" },
      { kind: "text", value: "rain" },
    ]);
    expect(compileLibrarySearchQuery(clauses)).toBe('"calm night" rain');
    expect(formatRemoteSearchQuery(clauses)).toBe('"calm night" rain');
    expect(parseSearchClauses(compileLibrarySearchQuery(clauses))).toEqual(clauses);
  });

  it("quotes values with spaces when serializing editable filters", () => {
    expect(formatSearchClause({ kind: "circle", value: 'Example "Circle"' })).toBe('circle:"Example Circle"');
    expect(formatSearchClause({ kind: "shelf", value: "unexpected" })).toBe("shelf:true");
  });
});
