import { describe, expect, it } from "vitest";

import type { WorkCardBadge } from "@/components/work-card/WorkCardShell";

import { libraryCoverSourceBadges } from "./libraryCoverSources";

const local: WorkCardBadge = { key: "source:local", label: "Local", variant: "secondary" };
const missingLocal: WorkCardBadge = { key: "source:local", label: "Local", variant: "warning" };
const tracked: WorkCardBadge = { key: "source:tracked:7", label: "Tracked", variant: "outline" };
const unforked: WorkCardBadge = { key: "source:tracked:7", label: "Unforked", variant: "warning" };
const remote: WorkCardBadge = { key: "source:remote:7", label: "Example Remote", variant: "outline" };
const remoteUnavailable: WorkCardBadge = {
  key: "source:remote:7:unavailable",
  label: "Example Remote unavailable",
  variant: "warning",
};

const catalog: WorkCardBadge = { key: "source:2", label: "Example Remote", variant: "outline" };
const catalogMissing: WorkCardBadge = { key: "source:2", label: "Example Remote", variant: "warning" };

const labels = (result: { sourceBadges: WorkCardBadge[] }) => result.sourceBadges.map((badge) => badge.label);

describe("library cover source marks", () => {
  it("automatically keeps only marks the current scope does not imply", () => {
    expect(libraryCoverSourceBadges([local], { kind: "local" }, "auto")).toEqual({
      sourceBadges: [],
      sourceUnavailableFallback: false,
    });
    expect(labels(libraryCoverSourceBadges([local, tracked], { kind: "local" }, "auto"))).toEqual(["Tracked"]);
    expect(labels(libraryCoverSourceBadges([missingLocal], { kind: "local" }, "auto"))).toEqual(["Local"]);
    expect(labels(libraryCoverSourceBadges([local, tracked], { kind: "tracked" }, "auto"))).toEqual(["Local"]);
    expect(labels(libraryCoverSourceBadges([unforked], { kind: "tracked" }, "auto"))).toEqual(["Unforked"]);
    expect(labels(libraryCoverSourceBadges([remote], { kind: "remote", sourceId: 7 }, "auto"))).toEqual([]);
    expect(labels(libraryCoverSourceBadges([remoteUnavailable], { kind: "remote", sourceId: 7 }, "auto"))).toEqual([
      "Example Remote unavailable",
    ]);
  });

  it("automatically leaves remote catalog listings off Local and Tracked covers", () => {
    expect(labels(libraryCoverSourceBadges([local, catalog, catalogMissing], { kind: "local" }, "auto"))).toEqual([]);
    expect(labels(libraryCoverSourceBadges([tracked, catalog], { kind: "tracked" }, "auto"))).toEqual([]);
    expect(labels(libraryCoverSourceBadges([local, catalog], { kind: "local" }, "always"))).toEqual([
      "Local",
      "Example Remote",
    ]);
  });

  it("still reports a work with no source at all", () => {
    expect(libraryCoverSourceBadges([], { kind: "local" }, "auto").sourceUnavailableFallback).toBe(true);
  });

  it("shows every mark or none when chosen", () => {
    expect(labels(libraryCoverSourceBadges([local, tracked], { kind: "local" }, "always"))).toEqual([
      "Local",
      "Tracked",
    ]);
    expect(libraryCoverSourceBadges([missingLocal], { kind: "local" }, "never")).toEqual({
      sourceBadges: [],
      sourceUnavailableFallback: false,
    });
  });
});
