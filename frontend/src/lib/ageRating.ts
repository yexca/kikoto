export type AgeRatingPresentation = {
  label: string;
  known: boolean;
  textClassName: string;
  badgeClassName: string;
};

export type AgeRating = "adult" | "r15" | "general";

const ageRatingAliases: Record<AgeRating, readonly string[]> = {
  adult: ["adult", "r18", "r-18", "18"],
  r15: ["r15", "r-15", "15"],
  general: [
    "general",
    "all",
    "all age",
    "all ages",
    "all-age",
    "all-ages",
    "all_age",
    "all_ages",
    "全年齢",
    "全年龄",
    "全年齡",
  ],
};

export const ageRatingValues: AgeRating[] = ["general", "r15", "adult"];

export function normalizeAgeRating(value: string): AgeRating | null {
  const normalized = value.trim().toLowerCase();
  return ageRatingValues.find((rating) => ageRatingAliases[rating].includes(normalized)) ?? null;
}

export function ageRatingMatches(value: string, query: string): boolean {
  const rating = normalizeAgeRating(query);
  return rating ? normalizeAgeRating(value) === rating : value.toLowerCase().includes(query.trim().toLowerCase());
}

export function ageRatingPresentation(value: string): AgeRatingPresentation {
  const normalized = normalizeAgeRating(value) ?? value.trim().toLowerCase();
  switch (normalized) {
    case "adult":
      return {
        label: "R18",
        known: true,
        textClassName: "text-destructive",
        badgeClassName: "border-destructive/40 bg-destructive/10 text-destructive",
      };
    case "r15":
      return {
        label: "R15",
        known: true,
        textClassName: "text-blue-600 dark:text-blue-300",
        badgeClassName: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
      };
    case "general":
      return {
        label: "全年齢",
        known: true,
        textClassName: "text-emerald-600 dark:text-emerald-300",
        badgeClassName: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "":
      return {
        label: "Unknown",
        known: false,
        textClassName: "text-muted-foreground",
        badgeClassName: "border-border bg-muted text-muted-foreground",
      };
    default:
      return {
        label: value,
        known: true,
        textClassName: "text-foreground",
        badgeClassName: "border-border bg-muted text-foreground",
      };
  }
}
