import type { WorkManualOverrides, WorkTitleChoice } from "@/lib/api";

export function manualTitles(manual: WorkManualOverrides): Record<string, string> {
  return { ...(manual.title ? { "": manual.title } : {}), ...manual.titles };
}

export function changedTitles(drafts: Record<string, string>, manual: WorkManualOverrides) {
  const previous = manualTitles(manual);
  return Object.fromEntries(
    Object.entries(drafts)
      .map(([language, title]) => [language, title.trim()] as const)
      .filter(([language, title]) => title !== (previous[language] ?? ""))
      .map(([language, title]) => [language, title || null]),
  );
}

export type TitleSourceLabel = { key: string; values?: Record<string, string> };

/**
 * Names where a scope's current title comes from: its own manual title, the
 * all-language manual title, a DLsite edition, a remote source, or the work's
 * own title. A remote title never belongs to a language.
 */
export function titleSourceLabel(
  language: string,
  manual: Record<string, string>,
  choice: WorkTitleChoice | undefined,
): TitleSourceLabel {
  if (manual[language]) return { key: language ? "workTitles.manual" : "workTitles.manualAll" };
  if (manual[""]) return { key: "workTitles.manualAll" };
  if (choice?.source === "dlsite") return { key: "workTitles.dlsite", values: { code: choice.code } };
  if (choice?.source === "remote" && choice.sourceName)
    return { key: "workTitles.remote", values: { source: choice.sourceName } };
  return { key: "workTitles.original" };
}
