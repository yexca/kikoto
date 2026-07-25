export type SearchClauseKind =
  | "text"
  | "code"
  | "circle"
  | "voice_actor"
  | "tag"
  | "exclude_tag"
  | "user_tag"
  | "exclude_user_tag"
  | "rating_min"
  | "sales_min"
  | "duration_min"
  | "duration_max"
  | "age"
  | "language"
  | "shelf";

export type SearchClause = { kind: SearchClauseKind; value: string };
export type SearchClauseDraft = { kind: SearchClauseKind; value: string };

export const editableSearchClauseKinds: { value: SearchClauseKind; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "code", label: "Code" },
  { value: "circle", label: "Circle" },
  { value: "voice_actor", label: "Voice actor" },
  { value: "tag", label: "Tag" },
  { value: "exclude_tag", label: "Not tag" },
  { value: "user_tag", label: "My tag" },
  { value: "exclude_user_tag", label: "Not my tag" },
  { value: "rating_min", label: "Rating >=" },
  { value: "sales_min", label: "Sales >=" },
  { value: "duration_min", label: "Duration >=" },
  { value: "duration_max", label: "Duration <=" },
  { value: "age", label: "Age" },
  { value: "language", label: "Language" },
  { value: "shelf", label: "On shelf" },
];

export function parseSearchClauses(query: string): SearchClause[] {
  const clauses: SearchClause[] = [];
  let rest = query;
  const wrappedPattern = /\$(-?mytag|-?tagw?|-?circle|-?va|duration|-duration|rate|sell|age|lang|shelf):([^$]+)\$/gi;
  rest = rest.replace(wrappedPattern, (_match, key: string, value: string) => {
    const clause = searchClauseFromKeyValue(key, value);
    if (clause) clauses.push(clause);
    return " ";
  });
  const parts = splitSearchParts(rest);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index].trim();
    if (!part) continue;
    const pendingPrefix = part.match(/^(-?mytag|-?tagw?|-?circle|-?va|circle|va|voice|creator|tag|duration|-duration|rate|rating|sell|sales|age|lang|language|shelf):$/i);
    if (pendingPrefix && index + 1 < parts.length) {
      const clause = searchClauseFromKeyValue(pendingPrefix[1], parts[index + 1]);
      if (clause) {
        clauses.push(clause);
        index += 1;
        continue;
      }
    }
    const prefixed = part.match(/^(-?mytag|-?tagw?|-?circle|-?va|circle|va|voice|creator|tag|duration|-duration|rate|rating|sell|sales|age|lang|language|shelf):(.+)$/i);
    if (prefixed) {
      const clause = searchClauseFromKeyValue(prefixed[1], prefixed[2]);
      if (clause) {
        clauses.push(clause);
        continue;
      }
    }
    if (/^(RJ|BJ|VJ|CC)\d{4,8}$/i.test(part)) {
      clauses.push({ kind: "code", value: part.toUpperCase() });
    } else {
      clauses.push({ kind: "text", value: part });
    }
  }
  return clauses.filter((clause) => clause.value.trim() !== "");
}

export function normalizeSearchClauseDraft(draft: SearchClauseDraft): SearchClause | null {
  const value = draft.value.trim();
  if (!value) return null;
  if (draft.kind === "code") return { kind: "code", value: value.toUpperCase() };
  if (draft.kind === "shelf") return { kind: "shelf", value: value === "false" ? "false" : "true" };
  return { kind: draft.kind, value };
}

export function compileLibrarySearchQuery(clauses: SearchClause[]) {
  return clauses.map((clause) => {
    switch (clause.kind) {
      case "code":
      case "text":
        return clause.value;
      case "circle":
        return `$circle:${clause.value}$`;
      case "voice_actor":
        return `$va:${clause.value}$`;
      case "tag":
        return `$tag:${clause.value}$`;
      case "exclude_tag":
        return `$-tag:${clause.value}$`;
      case "user_tag":
        return `$mytag:${clause.value}$`;
      case "exclude_user_tag":
        return `$-mytag:${clause.value}$`;
      case "rating_min":
        return `rating:${clause.value}`;
      case "sales_min":
        return `sales:${clause.value}`;
      case "duration_min":
        return `$duration:${clause.value}$`;
      case "duration_max":
        return `$-duration:${clause.value}$`;
      case "age":
        return `$age:${clause.value}$`;
      case "language":
        return `$lang:${clause.value}$`;
      case "shelf":
        return `shelf:${clause.value}`;
    }
  }).join(" ");
}

export function formatRemoteSearchQuery(clauses: SearchClause[]) {
  return clauses
    .map((clause): string | null => {
      switch (clause.kind) {
        case "circle":
          return `$circle:${clause.value}$`;
        case "voice_actor":
          return `$va:${clause.value}$`;
        case "tag":
          return `$tag:${clause.value}$`;
        case "exclude_tag":
          return `$-tag:${clause.value}$`;
        case "duration_min":
          return `$duration:${clause.value}$`;
        case "duration_max":
          return `$-duration:${clause.value}$`;
        case "rating_min":
          return `$rate:${clause.value}$`;
        case "sales_min":
          return `$sell:${clause.value}$`;
        case "age":
          return `$age:${clause.value}$`;
        case "language":
          return `$lang:${clause.value}$`;
        case "shelf":
          return null;
        default:
          return formatSearchClause(clause);
      }
    })
    .filter((value): value is string => value !== null && value !== "")
    .join(" ");
}

export function formatSearchClause(clause: SearchClause) {
  const value = formatSearchValue(clause.value);
  switch (clause.kind) {
    case "code":
    case "text":
      return value;
    case "circle":
      return `circle:${value}`;
    case "voice_actor":
      return `va:${value}`;
    case "tag":
      return `tag:${value}`;
    case "exclude_tag":
      return `-tag:${value}`;
    case "user_tag":
      return `mytag:${value}`;
    case "exclude_user_tag":
      return `-mytag:${value}`;
    case "rating_min":
      return `rating:${clause.value}`;
    case "sales_min":
      return `sales:${clause.value}`;
    case "duration_min":
      return `duration:${clause.value}`;
    case "duration_max":
      return `-duration:${clause.value}`;
    case "age":
      return `age:${value}`;
    case "language":
      return `lang:${value}`;
    case "shelf":
      return `shelf:${clause.value === "false" ? "false" : "true"}`;
  }
}

function splitSearchParts(value: string) {
  const parts: string[] = [];
  const pattern = /(\S+):"([^"]+)"|(\S+):'([^']+)'|"([^"]+)"|'([^']+)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match[1]) parts.push(`${match[1]}:${match[2]}`);
    else if (match[3]) parts.push(`${match[3]}:${match[4]}`);
    else parts.push(match[5] ?? match[6] ?? match[7] ?? "");
  }
  return parts;
}

function searchClauseFromKeyValue(key: string, rawValue: string): SearchClause | null {
  const normalizedKey = key.trim().toLowerCase();
  const value = rawValue.trim();
  if (!value) return null;
  switch (normalizedKey) {
    case "circle":
      return { kind: "circle", value };
    case "-circle":
      return { kind: "text", value: `-${value}` };
    case "va":
    case "-va":
    case "voice":
    case "creator":
      return { kind: "voice_actor", value };
    case "tag":
    case "tagw":
      return { kind: "tag", value };
    case "-tag":
    case "-tagw":
      return { kind: "exclude_tag", value };
    case "mytag":
      return { kind: "user_tag", value };
    case "-mytag":
      return { kind: "exclude_user_tag", value };
    case "rate":
    case "rating":
      return { kind: "rating_min", value };
    case "sell":
    case "sales":
      return { kind: "sales_min", value };
    case "duration":
      return { kind: "duration_min", value };
    case "-duration":
      return { kind: "duration_max", value };
    case "age":
      return { kind: "age", value };
    case "lang":
    case "language":
      return { kind: "language", value };
    case "shelf": {
      const normalized = value.toLowerCase();
      return normalized === "true" || normalized === "false" ? { kind: "shelf", value: normalized } : null;
    }
    default:
      return null;
  }
}

function formatSearchValue(value: string) {
  return /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}
