import { Check, Plus, X } from "lucide-react";
import { metadataEditorInitialState, workMetadataOverridePayload } from "./metadataEditorModel";
import { DebouncedSuggestionResult, useDebouncedSuggestion, useWorkCoverCandidates } from "./useMetadataSuggestions";

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

import { toastFromError, useToast } from "@/components/ui/toast";

import {
  api,
  assetURL,
  type CircleSuggestion,
  type ManualOverridePerson,
  type SeriesSuggestion,
  type VoiceSuggestion,
  type WorkCoverCandidate,
  type WorkDetail,
} from "@/lib/api";

import i18n from "@/i18n";

import { formatBytes } from "@/features/work-detail/media/mediaTreeModel";

function MetadataEditorCoverSection({
  manualCover,
  coverCandidates,
  selectedCoverId,
  loadingCovers,
  saving,
  onSelectCover,
  onReset,
}: {
  manualCover?: WorkDetail["manualOverrides"]["cover"];
  coverCandidates: WorkCoverCandidate[];
  selectedCoverId: number | null;
  loadingCovers: boolean;
  saving: boolean;
  onSelectCover: (locationId: number) => void;
  onReset: () => void;
}) {
  return (
    <>
      {manualCover?.url && (
        <div className="flex items-center gap-3 rounded-md border bg-background p-2">
          <img src={assetURL(manualCover.url)} alt="" className="h-16 w-16 rounded object-contain" />
          <div className="min-w-0 text-xs text-muted-foreground">
            <div className="truncate text-foreground">{manualCover.assetPath}</div>
            {manualCover.originalPath && <div className="truncate">{manualCover.originalPath}</div>}
          </div>
        </div>
      )}
      {loadingCovers ? (
        <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
          {i18n.t("libraryDetail.loadingCoverCandidates")}
        </div>
      ) : coverCandidates.length === 0 ? (
        <div className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
          {i18n.t("libraryDetail.noIndexedLocalImages")}
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {coverCandidates.map((candidate) => (
            <button
              key={candidate.locationId}
              className={`flex items-center gap-3 rounded-md border bg-background p-2 text-left hover:border-primary ${selectedCoverId === candidate.locationId ? "border-primary ring-1 ring-primary" : ""}`}
              onClick={() => onSelectCover(candidate.locationId)}
            >
              <img
                src={assetURL(candidate.previewUrl)}
                alt=""
                className="h-16 w-16 shrink-0 rounded object-contain"
                loading="lazy"
              />
              <span className="min-w-0 flex-1 text-xs">
                <span className="block truncate font-medium">{candidate.fileName}</span>
                <span className="block truncate text-muted-foreground">{candidate.path}</span>
                <span className="block text-muted-foreground">{formatBytes(candidate.sizeBytes)}</span>
              </span>
              {selectedCoverId === candidate.locationId && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={saving || !manualCover} onClick={onReset}>
          {i18n.t("libraryDetail.resetCover")}
        </Button>
      </div>
    </>
  );
}

function MetadataEditorCircleSection({
  name,
  externalId,
  suggestions,
  saving,
  hasManualValue,
  onNameChange,
  onExternalIdChange,
  onSuggestionSelect,
  onReset,
}: {
  name: string;
  externalId: string;
  suggestions: DebouncedSuggestionResult<CircleSuggestion>;
  saving: boolean;
  hasManualValue: boolean;
  onNameChange: (value: string) => void;
  onExternalIdChange: (value: string) => void;
  onSuggestionSelect: (item: CircleSuggestion) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <LabeledInput label={i18n.t("libraryDetail.name")} value={name} onChange={onNameChange} />
        <LabeledInput label={i18n.t("libraryDetail.externalId")} value={externalId} onChange={onExternalIdChange} />
      </div>
      <SuggestionList
        truncated={suggestions.truncated}
        emptyLabel={i18n.t("libraryDetail.typeToSearchCircles")}
        items={suggestions.items.map((item) => ({
          key: String(item.partyId),
          label: item.name,
          detail: item.externalId,
          onSelect: () => onSuggestionSelect(item),
        }))}
      />
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={saving || !hasManualValue} onClick={onReset}>
          {i18n.t("libraryDetail.resetCircle")}
        </Button>
      </div>
    </>
  );
}

function MetadataEditorSeriesSection({
  name,
  titleId,
  circleExternalId,
  suggestions,
  saving,
  hasManualValue,
  onNameChange,
  onTitleIdChange,
  onCircleExternalIdChange,
  onSuggestionSelect,
  onReset,
}: {
  name: string;
  titleId: string;
  circleExternalId: string;
  suggestions: DebouncedSuggestionResult<SeriesSuggestion>;
  saving: boolean;
  hasManualValue: boolean;
  onNameChange: (value: string) => void;
  onTitleIdChange: (value: string) => void;
  onCircleExternalIdChange: (value: string) => void;
  onSuggestionSelect: (item: SeriesSuggestion) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px_180px]">
        <LabeledInput label={i18n.t("libraryDetail.name")} value={name} onChange={onNameChange} />
        <LabeledInput label={i18n.t("libraryDetail.titleId")} value={titleId} onChange={onTitleIdChange} />
        <LabeledInput
          label={i18n.t("libraryDetail.circle")}
          value={circleExternalId}
          onChange={onCircleExternalIdChange}
        />
      </div>
      <SuggestionList
        truncated={suggestions.truncated}
        emptyLabel={i18n.t("libraryDetail.typeToSearchSeries")}
        items={suggestions.items.map((item) => ({
          key: String(item.seriesId),
          label: item.name,
          detail: [item.titleId, item.circleName, item.circleExternalId].filter(Boolean).join(" · "),
          onSelect: () => onSuggestionSelect(item),
        }))}
      />
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={saving || !hasManualValue} onClick={onReset}>
          {i18n.t("libraryDetail.resetSeries")}
        </Button>
      </div>
    </>
  );
}

function MetadataEditorVoiceActorsSection({
  voiceActors,
  suggestions,
  focusedVoiceIndex,
  saving,
  hasManualValue,
  onFocus,
  onUpdate,
  onRemove,
  onAdd,
  onSuggestionSelect,
  onReset,
}: {
  voiceActors: ManualOverridePerson[];
  suggestions: DebouncedSuggestionResult<VoiceSuggestion>;
  focusedVoiceIndex: number;
  saving: boolean;
  hasManualValue: boolean;
  onFocus: (index: number) => void;
  onUpdate: (index: number, patch: Partial<ManualOverridePerson>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onSuggestionSelect: (item: VoiceSuggestion) => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="space-y-2">
        {voiceActors.map((actor, index) => (
          <div key={`${index}:${actor.personId}`} className="grid gap-2 sm:grid-cols-[1fr_120px_auto]">
            <LabeledInput
              label={i18n.t("libraryDetail.name")}
              value={actor.name}
              onFocus={() => onFocus(index)}
              onChange={(value) => onUpdate(index, { name: value, personId: 0 })}
            />
            <LabeledInput
              label={i18n.t("libraryDetail.personId")}
              value={actor.personId ? String(actor.personId) : ""}
              onChange={(value) => onUpdate(index, { personId: Number(value) || 0 })}
            />
            <Button
              variant="outline"
              size="icon"
              className="mt-5 h-9 w-9"
              onClick={() => onRemove(index)}
              aria-label={i18n.t("libraryDetail.removeVoiceActor")}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
        {focusedVoiceIndex >= 0 && (
          <SuggestionList
            truncated={suggestions.truncated}
            emptyLabel={i18n.t("libraryDetail.typeToSearchVoices")}
            items={suggestions.items.map((item) => ({
              key: String(item.personId),
              label: item.name,
              detail: i18n.t("libraryDetail.personNumber", { id: item.personId }),
              onSelect: () => onSuggestionSelect(item),
            }))}
          />
        )}
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="h-4 w-4" />
          {i18n.t("libraryDetail.addVoice")}
        </Button>
        <Button variant="outline" size="sm" disabled={saving || !hasManualValue} onClick={onReset}>
          {i18n.t("libraryDetail.resetVoices")}
        </Button>
      </div>
    </>
  );
}

function useMetadataEditorActions({
  work,
  toast,
  title,
  circleName,
  circleExternalId,
  seriesName,
  seriesTitleId,
  seriesCircleExternalId,
  voiceActors,
  selectedCoverId,
  onSaved,
  onClose,
}: {
  work: WorkDetail;
  toast: ReturnType<typeof useToast>;
  title: string;
  circleName: string;
  circleExternalId: string;
  seriesName: string;
  seriesTitleId: string;
  seriesCircleExternalId: string;
  voiceActors: ManualOverridePerson[];
  selectedCoverId: number | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateWorkManualOverrides(
        work.id,
        workMetadataOverridePayload({
          title,
          circleName,
          circleExternalId,
          seriesName,
          seriesTitleId,
          seriesCircleExternalId,
          voiceActors,
        }),
      );
      if (selectedCoverId !== null) await api.setWorkCoverOverride(work.id, selectedCoverId);
      toast.success(i18n.t("libraryDetail.metadataOverridesSaved"));
      onSaved();
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, i18n.t("libraryDetail.metadataOverridesSaveFailed")));
    } finally {
      setSaving(false);
    }
  };

  const resetField = async (field: string) => {
    setSaving(true);
    try {
      await api.deleteWorkManualOverride(work.id, field);
      toast.success(i18n.t("libraryDetail.overrideReset"));
      onSaved();
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, i18n.t("libraryDetail.overrideResetFailed")));
    } finally {
      setSaving(false);
    }
  };

  return { saving, save, resetField };
}

export function WorkMetadataEditorModal({
  work,
  readOnly = false,
  onClose,
  onSaved,
}: {
  work: WorkDetail;
  readOnly?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const initialState = metadataEditorInitialState(work);
  const manual = initialState.manual;
  const [title, setTitle] = useState(initialState.title);
  const [circleName, setCircleName] = useState(initialState.circleName);
  const [circleExternalId, setCircleExternalId] = useState(initialState.circleExternalId);
  const [seriesName, setSeriesName] = useState(initialState.seriesName);
  const [seriesTitleId, setSeriesTitleId] = useState(initialState.seriesTitleId);
  const [seriesCircleExternalId, setSeriesCircleExternalId] = useState(initialState.seriesCircleExternalId);
  const [voiceActors, setVoiceActors] = useState<ManualOverridePerson[]>(() => initialState.voiceActors);
  const [focusedVoiceIndex, setFocusedVoiceIndex] = useState(-1);
  const coverState = useWorkCoverCandidates(work.id, toast);
  const circleQuery = circleName.trim();
  const circleSuggestions = useDebouncedSuggestion(circleQuery, circleName, () => api.suggestCircles(circleQuery));
  const seriesQuery = seriesName.trim();
  const seriesSuggestions = useDebouncedSuggestion(seriesQuery, `${seriesName}:${seriesCircleExternalId}`, () =>
    api.suggestSeries(seriesQuery, seriesCircleExternalId),
  );
  const focusedVoice = focusedVoiceIndex >= 0 ? voiceActors[focusedVoiceIndex] : null;
  const voiceQuery = focusedVoice?.name.trim() ?? "";
  const voiceSuggestions = useDebouncedSuggestion(voiceQuery, `${focusedVoiceIndex}:${focusedVoice?.name ?? ""}`, () =>
    api.suggestVoices(voiceQuery),
  );
  const { saving, save, resetField } = useMetadataEditorActions({
    work,
    toast,
    title,
    circleName,
    circleExternalId,
    seriesName,
    seriesTitleId,
    seriesCircleExternalId,
    voiceActors,
    selectedCoverId: coverState.selectedCoverId,
    onSaved,
    onClose,
  });

  const addVoiceActor = () => setVoiceActors((items) => [...items, { name: "", personId: 0 }]);
  const updateVoiceActor = (index: number, patch: Partial<ManualOverridePerson>) => {
    setVoiceActors((items) => items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  };
  const removeVoiceActor = (index: number) => {
    setVoiceActors((items) => items.filter((_, itemIndex) => itemIndex !== index));
  };

  return (
    <Dialog onClose={onClose} size="xl" dismissible={false} className="max-w-3xl">
      <DialogHeader
        title={i18n.t("libraryDetail.editMetadata")}
        description={work.primaryCode}
        onClose={onClose}
        closeLabel={i18n.t("content.close")}
      />
      <DialogBody>
        {/* Demo opens the editor for inspection; every field stays visible but cannot be changed. */}
        <fieldset disabled={readOnly} className="m-0 min-w-0 space-y-5 border-0 p-0">
          <EditorSection title={i18n.t("libraryDetail.work")}>
            <LabeledInput label={i18n.t("libraryDetail.title")} value={title} onChange={setTitle} />
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={saving || !manual.title}
                onClick={() => void resetField("title")}
              >
                {i18n.t("libraryDetail.resetTitle")}
              </Button>
            </div>
          </EditorSection>

          <EditorSection title={i18n.t("libraryDetail.cover")}>
            <MetadataEditorCoverSection
              manualCover={manual.cover}
              coverCandidates={coverState.coverCandidates}
              selectedCoverId={coverState.selectedCoverId}
              loadingCovers={coverState.loadingCovers}
              saving={saving}
              onSelectCover={coverState.setSelectedCoverId}
              onReset={() => void resetField("cover")}
            />
          </EditorSection>

          <EditorSection title={i18n.t("libraryDetail.circle")}>
            <MetadataEditorCircleSection
              name={circleName}
              externalId={circleExternalId}
              suggestions={circleSuggestions}
              saving={saving}
              hasManualValue={Boolean(manual.circle)}
              onNameChange={setCircleName}
              onExternalIdChange={setCircleExternalId}
              onSuggestionSelect={(item) => {
                setCircleName(item.name);
                setCircleExternalId(item.externalId);
                setSeriesCircleExternalId(item.externalId);
                circleSuggestions.clear();
              }}
              onReset={() => void resetField("circle")}
            />
          </EditorSection>

          <EditorSection title={i18n.t("libraryDetail.series")}>
            <MetadataEditorSeriesSection
              name={seriesName}
              titleId={seriesTitleId}
              circleExternalId={seriesCircleExternalId}
              suggestions={seriesSuggestions}
              saving={saving}
              hasManualValue={Boolean(manual.series)}
              onNameChange={setSeriesName}
              onTitleIdChange={setSeriesTitleId}
              onCircleExternalIdChange={setSeriesCircleExternalId}
              onSuggestionSelect={(item) => {
                setSeriesName(item.name);
                setSeriesTitleId(item.titleId);
                setSeriesCircleExternalId(item.circleExternalId);
                seriesSuggestions.clear();
              }}
              onReset={() => void resetField("series")}
            />
          </EditorSection>

          <EditorSection title={i18n.t("libraryDetail.voiceActors")}>
            <MetadataEditorVoiceActorsSection
              voiceActors={voiceActors}
              suggestions={voiceSuggestions}
              focusedVoiceIndex={focusedVoiceIndex}
              saving={saving}
              hasManualValue={Boolean(manual.voiceActors?.length)}
              onFocus={setFocusedVoiceIndex}
              onUpdate={updateVoiceActor}
              onRemove={removeVoiceActor}
              onAdd={addVoiceActor}
              onSuggestionSelect={(item) => {
                updateVoiceActor(focusedVoiceIndex, { name: item.name, personId: item.personId });
                voiceSuggestions.clear();
              }}
              onReset={() => void resetField("voice_actors")}
            />
          </EditorSection>
        </fieldset>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>
          {i18n.t("content.cancel")}
        </Button>
        <Button size="sm" disabled={readOnly || saving} onClick={() => void save()}>
          {saving ? i18n.t("common.saving") : i18n.t("content.save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function EditorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      {children}
    </section>
  );
}

function SuggestionList({
  items,
  truncated,
  emptyLabel,
}: {
  items: { key: string; label: string; detail: string; onSelect: () => void }[];
  truncated: boolean;
  emptyLabel: string;
}) {
  if (items.length === 0 && !truncated) {
    return <div className="text-xs text-muted-foreground">{emptyLabel}</div>;
  }
  return (
    <div className="space-y-1 rounded-md border bg-background p-1">
      {items.map((item) => (
        <button
          key={item.key}
          className="flex min-h-8 w-full items-center justify-between gap-3 rounded px-2 text-left text-xs hover:bg-muted"
          onClick={item.onSelect}
        >
          <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
          {item.detail && <span className="shrink-0 truncate text-muted-foreground">{item.detail}</span>}
        </button>
      ))}
      {truncated && (
        <div className="px-2 py-1 text-xs text-muted-foreground">{i18n.t("libraryDetail.tooManyMatches")}</div>
      )}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  onFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
}) {
  return (
    <label className="block min-w-0 text-xs font-medium text-muted-foreground">
      {label}
      <Input
        fieldSize="sm"
        className="mt-1 w-full"
        value={value}
        onFocus={onFocus}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
