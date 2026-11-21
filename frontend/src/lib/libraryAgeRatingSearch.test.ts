import { expect, it } from "vitest";
import { libraryAgeRatingSearchLocation } from "./libraryAgeRatingSearch";

it("replaces age filters and preserves the Library source and other clauses", () => {
  expect(libraryAgeRatingSearchLocation("R18", "/tracked?q=tag%3AExample+age%3Aall&page=2")).toBe(
    "/tracked?q=tag%3AExample+age%3Aadult",
  );
  expect(libraryAgeRatingSearchLocation("general", "/example_remote_a")).toBe("/example_remote_a?q=age%3Ageneral");
  expect(libraryAgeRatingSearchLocation("general", "/RJ00000000?source=2", "/example_remote_a?q=tag%3AExample")).toBe(
    "/example_remote_a?q=tag%3AExample+age%3Ageneral",
  );
  expect(libraryAgeRatingSearchLocation("R18", "/RJ00000000?view=tracked", "/tracked")).toBe("/tracked?q=age%3Aadult");
  expect(libraryAgeRatingSearchLocation("R18", "/example-work-a?source=2", "/example_remote_a")).toBe(
    "/example_remote_a?q=age%3Aadult",
  );
  expect(libraryAgeRatingSearchLocation("r15", "/favorites")).toBe("/?q=age%3Ar15");
  expect(libraryAgeRatingSearchLocation("r15", "/favorites?q=unrelated")).toBe("/?q=age%3Ar15");
  expect(libraryAgeRatingSearchLocation("", "/")).toBeNull();
});

it("opens the Library root from a page that is not a Library list", () => {
  expect(libraryAgeRatingSearchLocation("R18", "/insights")).toBe("/?q=age%3Aadult");
  expect(libraryAgeRatingSearchLocation("R18", "/discover?view=rankings&q=unrelated")).toBe("/?q=age%3Aadult");
  expect(libraryAgeRatingSearchLocation("general", "/RJ00000000", "/for-you")).toBe("/?q=age%3Ageneral");
});
