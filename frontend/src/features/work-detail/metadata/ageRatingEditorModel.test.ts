import { describe, expect, it } from "vitest";
import { ageRatingStatus, allowedManualAgeRatings, changedAgeRating, selectedAgeRating } from "./ageRatingEditorModel";

describe("age rating editor model", () => {
  it("fills in a missing provider rating or makes a known one stricter", () => {
    expect(allowedManualAgeRatings("")).toEqual(["general", "r15", "adult"]);
    expect(allowedManualAgeRatings("R15")).toEqual(["r15", "adult"]);
    expect(allowedManualAgeRatings("adult")).toEqual(["adult"]);
  });

  it("saves only a real change", () => {
    expect(changedAgeRating(undefined, undefined, "")).toBeUndefined();
    expect(changedAgeRating("general", undefined, "")).toBe("general");
    // Choosing the provider's own rating stores nothing.
    expect(changedAgeRating("r15", undefined, "r15")).toBeUndefined();
    expect(changedAgeRating("adult", "adult", "r15")).toBeUndefined();
    expect(changedAgeRating(null, "adult", "r15")).toBeNull();
  });

  it("shows the draft, then the manual rating, then the provider's", () => {
    expect(selectedAgeRating(undefined, undefined, "")).toBeNull();
    expect(selectedAgeRating(undefined, "adult", "general")).toBe("adult");
    expect(selectedAgeRating(null, "adult", "general")).toBe("general");
    expect(ageRatingStatus(undefined, "adult", "general")).toBe("manual");
    expect(ageRatingStatus(null, "adult", "general")).toBe("reverting");
    expect(ageRatingStatus("r15", undefined, "")).toBe("edited");
  });
});
