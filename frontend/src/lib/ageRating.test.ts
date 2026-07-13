import { describe, expect, it } from "vitest";

import { ageRatingPresentation } from "./ageRating";

describe("age rating presentation", () => {
  it("normalizes known ratings and leaves missing ratings hidden on cards", () => {
    expect(ageRatingPresentation("adult")).toMatchObject({ label: "R18", known: true });
    expect(ageRatingPresentation("R-15")).toMatchObject({ label: "R15", known: true });
    expect(ageRatingPresentation("all ages")).toMatchObject({ label: "全年齢", known: true });
    expect(ageRatingPresentation("")).toMatchObject({ label: "Unknown", known: false });
  });
});
