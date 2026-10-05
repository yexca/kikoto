import type { WorkManualOverrides } from "@/lib/api";

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
