import { describe, expect, it } from "vitest";
import { ageRatingMatches, ageRatingPresentation, normalizeAgeRating } from "./ageRating";

describe("age rating presentation", () => {
  it("normalizes known ratings and leaves missing ratings hidden on cards", () => {
    expect(ageRatingPresentation("adult")).toMatchObject({ label: "R18", known: true });
    expect(ageRatingPresentation("R-15")).toMatchObject({ label: "R15", known: true });
    expect(ageRatingPresentation("all ages")).toMatchObject({ label: "全年齢", known: true });
    expect(ageRatingPresentation("")).toMatchObject({ label: "Unknown", known: false });
  });
});

describe("age rating search", () => {
  it("matches the displayed category across provider aliases", () => {
    for (const value of ["adult", "R18", "r-18", "18"]) {
      expect(ageRatingMatches(value, ageRatingPresentation("adult").label)).toBe(true);
    }
    for (const value of ["general", "all ages", "全年齢", "全年龄", "全年齡"]) {
      expect(normalizeAgeRating(value)).toBe("general");
      expect(ageRatingMatches(value, "all")).toBe(true);
    }
    expect(ageRatingMatches("r15", "R-15")).toBe(true);
    expect(ageRatingMatches("adult", "R15")).toBe(false);
    expect(ageRatingMatches("", "R18")).toBe(false);
  });
});
