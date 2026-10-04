import {
  type ManualOverridePerson,
  type ManualOverrideSeries,
  type WorkDetail,
  type WorkManualOverridePayload,
} from "@/lib/api";

function normalizedOverrides({
  title,
  circleName,
  circleExternalId,
  seriesName,
  seriesTitleId,
  seriesCircleExternalId,
  voiceActors,
}: {
  title: string;
  circleName: string;
  circleExternalId: string;
  seriesName: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  voiceActors: ManualOverridePerson[];
}) {
  return {
    title: nullableTrimmed(title),
    circle: nullableEntity(circleName, circleExternalId),
    series: nullableSeries(seriesName, seriesTitleId, seriesCircleExternalId),
    voiceActors: voiceActors
      .map((actor) => ({ name: actor.name.trim(), personId: Number(actor.personId) || 0 }))
      .filter((actor) => actor.name),
  };
}

export type MetadataEditorState = Parameters<typeof normalizedOverrides>[0];

export function workMetadataOverridePayload(
  state: MetadataEditorState,
  initial: MetadataEditorState,
): WorkManualOverridePayload {
  const next = normalizedOverrides(state);
  const previous = normalizedOverrides(initial);
  return Object.fromEntries(
    Object.entries(next).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key as keyof typeof previous]),
    ),
  );
}

type EditableWorkMetadata = Pick<
  WorkDetail,
  | "manualOverrides"
  | "title"
  | "circle"
  | "circleExternalId"
  | "series"
  | "seriesTitleId"
  | "seriesCircleExternalId"
  | "voiceCredits"
  | "voiceActors"
>;

export function metadataEditorInitialState(work: EditableWorkMetadata) {
  const manual = work.manualOverrides ?? {};
  return {
    manual,
    title: manual.title ?? work.title,
    circleName: manual.circle?.name ?? work.circle,
    circleExternalId: manual.circle?.externalId ?? work.circleExternalId,
    seriesName: manual.series?.name ?? work.series,
    seriesTitleId: manual.series?.titleId ?? work.seriesTitleId ?? "",
    seriesCircleExternalId:
      manual.series?.circleExternalId ?? work.seriesCircleExternalId ?? work.circleExternalId ?? "",
    voiceActors: initialManualVoiceActors(work),
  };
}

function initialManualVoiceActors(work: EditableWorkMetadata): ManualOverridePerson[] {
  const manual = work.manualOverrides?.voiceActors;
  if (manual && manual.length > 0) return manual;
  if (work.voiceCredits.length > 0) {
    return work.voiceCredits.map((credit) => ({ name: credit.displayName, personId: credit.personId }));
  }
  return work.voiceActors.map((name) => ({ name, personId: 0 }));
}

function nullableTrimmed(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableEntity(name: string, externalId: string) {
  const nextName = name.trim();
  const nextExternalId = externalId.trim();
  return nextName || nextExternalId ? { name: nextName, externalId: nextExternalId } : null;
}

function nullableSeries(name: string, titleId: string, circleExternalId: string): ManualOverrideSeries | null {
  const nextName = name.trim();
  const nextTitleId = titleId.trim();
  const nextCircleExternalId = circleExternalId.trim();
  return nextName || nextTitleId || nextCircleExternalId
    ? { name: nextName, titleId: nextTitleId, circleExternalId: nextCircleExternalId }
    : null;
}

const metadataLinkCodePattern = /^(RJ|BJ|VJ)[0-9]{5,8}$/;

/** Returns the DLsite code a work may take its metadata from, or null when the input is not one. */
export function normalizedMetadataLinkCode(value: string, primaryCode: string): string | null {
  const code = value.trim().toUpperCase();
  if (!metadataLinkCodePattern.test(code) || code === primaryCode.trim().toUpperCase()) return null;
  return code;
}
