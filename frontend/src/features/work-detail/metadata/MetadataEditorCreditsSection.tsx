import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api, type ManualOverridePerson } from "@/lib/api";
import { MetadataEditorField, SuggestionCombobox } from "./MetadataEditorFields";
import {
  metadataEditorInitialState,
  workMetadataOverridePayload,
  type MetadataEditorReverts,
  type MetadataEditorState,
  type MetadataFieldStatus,
} from "./metadataEditorModel";
import { useDebouncedSuggestion } from "./useMetadataSuggestions";

type CreditField = keyof MetadataEditorReverts;

/** Owns circle, series, and voice actor drafts plus their staged reverts. */
export function useMetadataCreditsEditor(initialState: ReturnType<typeof metadataEditorInitialState>) {
  const [state, setState] = useState<MetadataEditorState>(initialState);
  const [reverts, setReverts] = useState<MetadataEditorReverts>({});
  const payload = workMetadataOverridePayload(state, initialState, reverts);
  const { manual } = initialState;
  const hasManual: Record<CreditField, boolean> = {
    circle: Boolean(manual.circle),
    series: Boolean(manual.series),
    voiceActors: Boolean(manual.voiceActors?.length),
  };
  const status = (field: CreditField): MetadataFieldStatus => {
    if (reverts[field]) return "reverting";
    if (field in payload) return "edited";
    return hasManual[field] ? "manual" : "source";
  };
  const update = (patch: Partial<MetadataEditorState>) => setState((current) => ({ ...current, ...patch }));
  const setRevert = (field: CreditField, value: boolean) => {
    setReverts((current) => ({ ...current, [field]: value }));
    // Undoing a revert starts again from the saved override rather than a discarded draft.
    if (!value) {
      if (field === "circle")
        update({ circleName: initialState.circleName, circleExternalId: initialState.circleExternalId });
      if (field === "series")
        update({
          seriesName: initialState.seriesName,
          seriesTitleId: initialState.seriesTitleId,
          seriesCircleExternalId: initialState.seriesCircleExternalId,
        });
      if (field === "voiceActors") update({ voiceActors: initialState.voiceActors });
    }
  };
  return { state, reverts, payload, status, update, setRevert };
}

export type MetadataCreditsEditor = ReturnType<typeof useMetadataCreditsEditor>;

export function MetadataEditorCreditsSection({ editor }: { editor: MetadataCreditsEditor }) {
  return (
    <div className="space-y-6">
      <CircleField editor={editor} />
      <SeriesField editor={editor} />
      <VoiceActorsField editor={editor} />
    </div>
  );
}

function CircleField({ editor }: { editor: MetadataCreditsEditor }) {
  const { t } = useTranslation();
  const { circleName, circleExternalId } = editor.state;
  const [editingId, setEditingId] = useState(false);
  const query = circleName.trim();
  const suggestions = useDebouncedSuggestion(query, circleName, () => api.suggestCircles(query));
  return (
    <MetadataEditorField
      label={t("libraryDetail.circle")}
      labelFor="metadata-editor-circle"
      status={editor.status("circle")}
      revertLabel={t("libraryDetail.resetCircle")}
      onRevert={() => editor.setRevert("circle", true)}
      onUndoRevert={() => editor.setRevert("circle", false)}
    >
      <SuggestionCombobox
        id="metadata-editor-circle"
        value={circleName}
        placeholder={t("metadataEditor.searchCircles")}
        onChange={(value) => editor.update({ circleName: value })}
        truncated={suggestions.truncated}
        options={suggestions.items.map((item) => ({
          key: String(item.partyId),
          label: item.name,
          detail: item.externalId,
          onSelect: () => {
            editor.update({
              circleName: item.name,
              circleExternalId: item.externalId,
              seriesCircleExternalId: item.externalId,
            });
            suggestions.clear();
          },
        }))}
      />
      <IdentityLine
        ids={[{ label: t("libraryDetail.externalId"), value: circleExternalId }]}
        editing={editingId}
        onToggle={() => setEditingId((value) => !value)}
      >
        <LabeledInput
          label={t("libraryDetail.externalId")}
          value={circleExternalId}
          onChange={(value) => editor.update({ circleExternalId: value })}
        />
      </IdentityLine>
    </MetadataEditorField>
  );
}

function SeriesField({ editor }: { editor: MetadataCreditsEditor }) {
  const { t } = useTranslation();
  const { seriesName, seriesTitleId, seriesCircleExternalId } = editor.state;
  const [editingId, setEditingId] = useState(false);
  const query = seriesName.trim();
  const suggestions = useDebouncedSuggestion(query, `${seriesName}:${seriesCircleExternalId}`, () =>
    api.suggestSeries(query, seriesCircleExternalId),
  );
  return (
    <MetadataEditorField
      label={t("libraryDetail.series")}
      labelFor="metadata-editor-series"
      status={editor.status("series")}
      revertLabel={t("libraryDetail.resetSeries")}
      onRevert={() => editor.setRevert("series", true)}
      onUndoRevert={() => editor.setRevert("series", false)}
    >
      <SuggestionCombobox
        id="metadata-editor-series"
        value={seriesName}
        placeholder={t("metadataEditor.searchSeries")}
        onChange={(value) => editor.update({ seriesName: value })}
        truncated={suggestions.truncated}
        options={suggestions.items.map((item) => ({
          key: String(item.seriesId),
          label: item.name,
          detail: [item.titleId, item.circleName].filter(Boolean).join(" · "),
          onSelect: () => {
            editor.update({
              seriesName: item.name,
              seriesTitleId: item.titleId,
              seriesCircleExternalId: item.circleExternalId,
            });
            suggestions.clear();
          },
        }))}
      />
      <IdentityLine
        ids={[
          { label: t("libraryDetail.titleId"), value: seriesTitleId },
          { label: t("metadataEditor.seriesCircleId"), value: seriesCircleExternalId },
        ]}
        editing={editingId}
        onToggle={() => setEditingId((value) => !value)}
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <LabeledInput
            label={t("libraryDetail.titleId")}
            value={seriesTitleId}
            onChange={(value) => editor.update({ seriesTitleId: value })}
          />
          <LabeledInput
            label={t("metadataEditor.seriesCircleId")}
            value={seriesCircleExternalId}
            onChange={(value) => editor.update({ seriesCircleExternalId: value })}
          />
        </div>
      </IdentityLine>
    </MetadataEditorField>
  );
}

function VoiceActorsField({ editor }: { editor: MetadataCreditsEditor }) {
  const { t } = useTranslation();
  const { voiceActors } = editor.state;
  const [draft, setDraft] = useState("");
  const query = draft.trim();
  const suggestions = useDebouncedSuggestion(query, draft, () => api.suggestVoices(query));
  const add = (actor: ManualOverridePerson) => {
    const name = actor.name.trim();
    if (!name) return;
    const duplicate = voiceActors.some((item) =>
      actor.personId ? item.personId === actor.personId : item.name.trim() === name,
    );
    if (!duplicate) editor.update({ voiceActors: [...voiceActors, { name, personId: actor.personId }] });
    setDraft("");
    suggestions.clear();
  };
  const remove = (index: number) =>
    editor.update({ voiceActors: voiceActors.filter((_, itemIndex) => itemIndex !== index) });
  return (
    <MetadataEditorField
      label={t("libraryDetail.voiceActors")}
      labelFor="metadata-editor-voice"
      status={editor.status("voiceActors")}
      revertLabel={t("libraryDetail.resetVoices")}
      onRevert={() => editor.setRevert("voiceActors", true)}
      onUndoRevert={() => editor.setRevert("voiceActors", false)}
      hint={t("metadataEditor.voiceHint")}
    >
      <ul className="flex flex-wrap gap-1.5" aria-label={t("libraryDetail.voiceActors")}>
        {voiceActors.map((actor, index) => (
          <li
            key={`${index}:${actor.personId}:${actor.name}`}
            className="inline-flex max-w-full items-center gap-1 rounded-md border bg-card py-0.5 pl-2 pr-0.5 text-sm"
          >
            {actor.personId > 0 && (
              <Link2
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-label={t("libraryDetail.personNumber", { id: actor.personId })}
              />
            )}
            <span className="min-w-0 truncate">{actor.name}</span>
            <button
              type="button"
              className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("metadataEditor.removeVoiceActor", { name: actor.name })}
              onClick={() => remove(index)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {!voiceActors.length && <li className="text-sm text-muted-foreground">{t("metadataEditor.noVoiceActors")}</li>}
      </ul>
      <div className="mt-2">
        <SuggestionCombobox
          id="metadata-editor-voice"
          value={draft}
          placeholder={t("metadataEditor.addVoiceActor")}
          onChange={setDraft}
          truncated={suggestions.truncated}
          onSubmitText={(value) => {
            const exact = suggestions.items.find((item) => item.name === value.trim());
            add(exact ?? { name: value, personId: 0 });
          }}
          options={[
            ...suggestions.items
              .filter((item) => !voiceActors.some((actor) => actor.personId === item.personId))
              .map((item) => ({
                key: String(item.personId),
                label: item.name,
                detail: t("libraryDetail.personNumber", { id: item.personId }),
                onSelect: () => add(item),
              })),
            ...(query && !suggestions.items.some((item) => item.name === query)
              ? [
                  {
                    key: "new",
                    label: t("metadataEditor.addUnlinkedVoice", { name: query }),
                    onSelect: () => add({ name: query, personId: 0 }),
                  },
                ]
              : []),
          ]}
        />
      </div>
    </MetadataEditorField>
  );
}

/** Shows the identifiers behind a credit name, with an optional editor for them. */
function IdentityLine({
  ids,
  editing,
  onToggle,
  children,
}: {
  ids: { label: string; value: string }[];
  editing: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const known = ids.filter((id) => id.value.trim());
  return (
    <div className="mt-1.5 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {known.length ? (
          known.map((id) => (
            <span key={id.label} className="inline-flex min-w-0 items-center gap-1">
              <Link2 className="h-3 w-3 shrink-0" />
              <span className="truncate">
                {id.label}: <span className="font-mono">{id.value}</span>
              </span>
            </span>
          ))
        ) : (
          <span>{t("metadataEditor.notLinked")}</span>
        )}
        <button
          type="button"
          className="rounded text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={editing}
          onClick={onToggle}
        >
          {editing ? t("metadataEditor.hideIds") : t("metadataEditor.editIds")}
        </button>
      </div>
      {editing && children}
    </div>
  );
}

function LabeledInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block min-w-0 text-xs font-medium text-muted-foreground">
      {label}
      <Input
        fieldSize="sm"
        className="mt-1 w-full font-mono"
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
