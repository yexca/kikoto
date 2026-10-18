import { ageRatingValues, normalizeAgeRating, type AgeRating } from "@/lib/ageRating";
import type { MetadataFieldStatus } from "./metadataEditorModel";

/** A staged age rating: a rating to save, null to remove the manual one, or undefined for no change. */
export type AgeRatingDraft = AgeRating | null | undefined;

const strictness: Record<AgeRating, number> = { general: 1, r15: 2, adult: 3 };

/**
 * The ratings a manual override may choose. A manual rating fills in a missing
 * provider rating or makes a known one stricter, never relaxes it.
 */
export function allowedManualAgeRatings(provider: string): AgeRating[] {
  const known = normalizeAgeRating(provider);
  return ageRatingValues.filter((rating) => !known || strictness[rating] >= strictness[known]);
}

/** The rating the field shows: the draft, then the saved manual rating, then the provider's. */
export function selectedAgeRating(draft: AgeRatingDraft, own: string | undefined, provider: string): AgeRating | null {
  if (draft !== undefined) return draft ?? normalizeAgeRating(provider);
  return normalizeAgeRating(own ?? "") ?? normalizeAgeRating(provider);
}

/**
 * The value to save, or undefined when nothing changes. Choosing the provider's
 * own rating on a work without a manual one stores nothing.
 */
export function changedAgeRating(draft: AgeRatingDraft, own: string | undefined, provider: string): AgeRatingDraft {
  const saved = normalizeAgeRating(own ?? "");
  if (draft === undefined || draft === saved) return undefined;
  if (!saved && draft === normalizeAgeRating(provider)) return undefined;
  return draft;
}

export function ageRatingStatus(draft: AgeRatingDraft, own: string | undefined, provider: string): MetadataFieldStatus {
  const saved = normalizeAgeRating(own ?? "");
  const change = changedAgeRating(draft, own, provider);
  if (change === undefined) return saved ? "manual" : "source";
  return change === null ? "reverting" : "edited";
}
