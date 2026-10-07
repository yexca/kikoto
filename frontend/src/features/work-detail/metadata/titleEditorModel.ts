import type { WorkDetail, WorkManualOverrides, WorkTitleChoice } from "@/lib/api";
import { metadataTagLanguages } from "@/lib/metadataTagModel";
import { resolveMetadataVariant } from "../metadataPresentationModel";
import { manualValueStatus } from "./metadataEditorModel";

/** Uses declared metadata languages, preserving an unknown original language. */
export function titleLanguageMarkers(
  work: Pick<WorkDetail, "metadataPresentation" | "titleChoices">,
  selectedMetadataVariantKey: string,
) {
  const original = work.metadataPresentation.variants.find((variant) => variant.origin);
  const current = resolveMetadataVariant(work.metadataPresentation, selectedMetadataVariantKey);
  return {
    origin: (original?.language ?? work.titleChoices?.origin?.language ?? "").trim().toLowerCase(),
    current: (current?.language ?? "").trim().toLowerCase(),
  };
}

export function manualTitles(manual: WorkManualOverrides): Record<string, string> {
  return { ...(manual.title ? { "": manual.title } : {}), ...manual.titles };
}

/**
 * The title each scope shows before editing: its own manual title, or the
 * title it currently inherits from the universal title or a provider.
 */
export function currentTitles(
  work: Pick<WorkDetail, "title" | "titleChoices" | "manualOverrides">,
): Record<string, string> {
  const manual = manualTitles(work.manualOverrides ?? {});
  return Object.fromEntries(
    metadataTagLanguages.map(([language]) => [
      language,
      manual[language] || work.titleChoices?.[language]?.title || manual[""] || work.title,
    ]),
  );
}

/**
 * A draft only changes a scope when it differs from what the scope already
 * shows. Clearing or keeping an inherited title leaves it inherited.
 */
function titleDraftChanges(title: string, own: string | undefined, current: string | undefined) {
  return own ? title !== own : title !== "" && title !== current;
}

export function changedTitles(
  drafts: Record<string, string>,
  manual: WorkManualOverrides,
  current: Record<string, string> = {},
) {
  const previous = manualTitles(manual);
  return Object.fromEntries(
    Object.entries(drafts)
      .map(([language, title]) => [language, title.trim()] as const)
      .filter(([language, title]) => titleDraftChanges(title, previous[language], current[language]))
      .map(([language, title]) => [language, title || null]),
  );
}

export function titleFieldStatus(draft: string | undefined, own: string | undefined, current: string | undefined) {
  if (draft !== undefined && !titleDraftChanges(draft.trim(), own, current)) return own ? "manual" : "source";
  return manualValueStatus(draft, own);
}

export type TitleSourceLabel = { key: string; values?: Record<string, string> };

/**
 * Names where a scope's current title comes from: its own manual title, the
 * all-language manual title, a DLsite edition, a remote source, or the work's
 * own title. Remote language titles require a provider-declared edition.
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
