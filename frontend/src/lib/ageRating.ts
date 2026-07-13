export type AgeRatingPresentation = {
  label: string;
  known: boolean;
  textClassName: string;
  badgeClassName: string;
};

export function ageRatingPresentation(value: string): AgeRatingPresentation {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
  case "adult":
  case "r18":
  case "r-18":
  case "18":
    return {
      label: "R18",
      known: true,
      textClassName: "text-destructive",
      badgeClassName: "border-destructive/40 bg-destructive/10 text-destructive",
    };
  case "r15":
  case "r-15":
  case "15":
    return {
      label: "R15",
      known: true,
      textClassName: "text-blue-600 dark:text-blue-300",
      badgeClassName: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
    };
  case "general":
  case "all":
  case "全年齢":
  case "all ages":
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
