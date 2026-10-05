import { useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Image, Link2, Tags, Type, Users, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toastFromError, useToast } from "@/components/ui/toast";
import { api, type WorkDetail, type WorkMetadataLinkResult } from "@/lib/api";
import { cn } from "@/lib/tailwindClassNames";
import { MetadataEditorCoverSection, coverFieldStatus } from "./MetadataEditorCoverSection";
import { MetadataEditorCreditsSection, useMetadataCreditsEditor } from "./MetadataEditorCreditsSection";
import { MetadataEditorSourceSection, type StagedMetadataLink } from "./MetadataEditorSourceSection";
import { WorkMetadataTagsSection } from "./WorkMetadataTagsSection";
import { WorkTitleEditor } from "./WorkTitleEditor";
import { metadataEditorInitialState, payloadChangesCredits } from "./metadataEditorModel";
import { changedTitles } from "./titleEditorModel";
import { useWorkCoverCandidates } from "./useMetadataSuggestions";
import { useWorkMetadataTagsEditor } from "./useWorkMetadataTagsEditor";

export type MetadataEditorSection = "title" | "cover" | "tags" | "credits" | "source";

const sections: { id: MetadataEditorSection; icon: LucideIcon }[] = [
  { id: "title", icon: Type },
  { id: "cover", icon: Image },
  { id: "tags", icon: Tags },
  { id: "credits", icon: Users },
  { id: "source", icon: Link2 },
];

/**
 * Edits one work's manual metadata. Every change, including reverts and the
 * metadata link, stays a draft until Save applies them together, so moving
 * between sections never loses or half-applies an edit.
 */
export function WorkMetadataEditorModal({
  work,
  readOnly = false,
  initialSection = "title",
  onClose,
  onSaved,
  onLinkChanged,
}: {
  work: WorkDetail;
  readOnly?: boolean;
  initialSection?: MetadataEditorSection;
  onClose: () => void;
  onSaved: () => void;
  onLinkChanged: (result: WorkMetadataLinkResult) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [section, setSection] = useState(initialSection);
  const [initialState] = useState(() => metadataEditorInitialState(work));
  const manual = initialState.manual;
  const [titleDrafts, setTitleDrafts] = useState<Record<string, string>>({});
  const credits = useMetadataCreditsEditor(initialState);
  const tagEditor = useWorkMetadataTagsEditor(work.id);
  const coverState = useWorkCoverCandidates(work.id, toast);
  const [coverReverted, setCoverReverted] = useState(false);
  const [stagedLink, setStagedLink] = useState<StagedMetadataLink>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const tabRefs = useRef<Partial<Record<MetadataEditorSection, HTMLButtonElement | null>>>({});

  const titles = changedTitles(titleDrafts, manual);
  const coverChanged = coverState.selectedCoverId !== coverState.initialCoverId;
  const changed: Record<MetadataEditorSection, boolean> = {
    title: Object.keys(titles).length > 0,
    cover: coverChanged || coverReverted,
    tags: tagEditor.changed,
    credits: payloadChangesCredits(credits.payload),
    source: stagedLink !== null,
  };
  const changedSections = sections.filter((item) => changed[item.id]);
  const dirty = changedSections.length > 0;

  const requestClose = () => {
    if (saving) return;
    if (dirty && !readOnly) setConfirmingDiscard(true);
    else onClose();
  };

  const save = async () => {
    if (!dirty || saving || readOnly) return;
    setSaving(true);
    setConfirmingDiscard(false);
    // Reload the caller after a partial failure so it shows what did save.
    let applied = false;
    try {
      const payload = { ...credits.payload };
      if (changed.title) payload.titles = titles;
      if (Object.keys(payload).length) {
        await api.updateWorkManualOverrides(work.id, payload);
        applied = true;
      }
      if (changed.tags) {
        await tagEditor.save();
        applied = true;
      }
      if (coverChanged && coverState.selectedCoverId !== null) {
        await api.setWorkCoverOverride(work.id, coverState.selectedCoverId);
        applied = true;
      } else if (coverReverted) {
        await api.deleteWorkManualOverride(work.id, "cover");
        applied = true;
      }
      let linkResult: WorkMetadataLinkResult | null = null;
      if (stagedLink?.action === "link") linkResult = await api.setWorkMetadataLink(work.id, stagedLink.code);
      else if (stagedLink?.action === "unlink") linkResult = await api.deleteWorkMetadataLink(work.id);
      if (linkResult) {
        const refreshing = Boolean(linkResult.sync && linkResult.sync.runId > 0);
        toast.success(
          stagedLink?.action === "unlink"
            ? t("libraryDetail.metadataLinkRemoved")
            : t(refreshing ? "libraryDetail.metadataLinkSavedRefreshing" : "libraryDetail.metadataLinkSaved", {
                code: linkResult.link?.sourceCode ?? "",
              }),
        );
        onLinkChanged(linkResult);
      } else {
        toast.success(t("libraryDetail.metadataOverridesSaved"));
        onSaved();
      }
      onClose();
    } catch (error) {
      toast.notify(toastFromError(error, t("libraryDetail.metadataOverridesSaveFailed")));
      if (applied) onSaved();
    } finally {
      setSaving(false);
    }
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
    const edge = { Home: 0, End: sections.length - 1 }[event.key];
    if (step === undefined && edge === undefined) return;
    event.preventDefault();
    const index = sections.findIndex((item) => item.id === section);
    const next = sections[edge ?? (index + (step ?? 0) + sections.length) % sections.length].id;
    setSection(next);
    tabRefs.current[next]?.focus();
  };

  const sectionLabel = (id: MetadataEditorSection) => t(`metadataEditor.sections.${id}`);

  return (
    <Dialog
      onClose={requestClose}
      size="2xl"
      dismissible={false}
      marker="work-metadata-editor"
      className="h-[calc(100dvh-1.5rem)] sm:h-[min(42rem,calc(100dvh-2rem))]"
    >
      <DialogHeader
        title={t("libraryDetail.editMetadata")}
        description={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xs">{work.primaryCode}</span>
            <span className="truncate">{work.title}</span>
          </span>
        }
        onClose={saving ? undefined : requestClose}
        closeLabel={t("content.close")}
      />
      <div
        className="flex min-h-0 flex-1 flex-col sm:flex-row"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void save();
          }
        }}
      >
        <div
          role="tablist"
          aria-label={t("metadataEditor.sectionsLabel")}
          className="app-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2 sm:w-48 sm:flex-col sm:overflow-x-visible sm:border-b-0 sm:border-r sm:px-2 sm:py-3"
        >
          {sections.map(({ id, icon: Icon }) => {
            const selected = section === id;
            return (
              <button
                key={id}
                ref={(element) => {
                  tabRefs.current[id] = element;
                }}
                type="button"
                role="tab"
                id={`metadata-editor-tab-${id}`}
                aria-selected={selected}
                aria-controls="metadata-editor-panel"
                tabIndex={selected ? 0 : -1}
                className={cn(
                  "relative flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "bg-secondary font-medium text-secondary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                onClick={() => setSection(id)}
                onKeyDown={onTabKeyDown}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="whitespace-nowrap sm:flex-1 sm:text-left">{sectionLabel(id)}</span>
                {changed[id] && (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-primary">
                    <span className="sr-only">{t("metadataEditor.unsavedMarker")}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <DialogBody
          id="metadata-editor-panel"
          role="tabpanel"
          aria-labelledby={`metadata-editor-tab-${section}`}
          className="sm:px-6 sm:py-5"
        >
          {/* Demo opens the editor for inspection; every field stays visible but cannot be changed. */}
          <fieldset disabled={readOnly || saving} className="m-0 min-w-0 space-y-5 border-0 p-0">
            <p className="text-sm text-muted-foreground">{t(`metadataEditor.descriptions.${section}`)}</p>
            {section === "title" && (
              <WorkTitleEditor
                work={work}
                drafts={titleDrafts}
                onDraft={(language, title) => setTitleDrafts((current) => ({ ...current, [language]: title }))}
              />
            )}
            {section === "cover" && (
              <MetadataEditorCoverSection
                manualCover={manual.cover}
                candidates={coverState.coverCandidates}
                selectedCoverId={coverState.selectedCoverId}
                status={coverFieldStatus({
                  manualCover: manual.cover,
                  selectedCoverId: coverState.selectedCoverId,
                  initialCoverId: coverState.initialCoverId,
                  reverted: coverReverted,
                })}
                loading={coverState.loadingCovers}
                onSelect={(locationId) => {
                  coverState.setSelectedCoverId(locationId);
                  setCoverReverted(false);
                }}
                onRevert={() => setCoverReverted(true)}
                onUndoRevert={() => setCoverReverted(false)}
              />
            )}
            {section === "tags" && <WorkMetadataTagsSection editor={tagEditor} />}
            {section === "credits" && <MetadataEditorCreditsSection editor={credits} />}
            {section === "source" && (
              <MetadataEditorSourceSection
                link={work.metadataLink}
                primaryCode={work.primaryCode}
                staged={stagedLink}
                onStage={setStagedLink}
              />
            )}
          </fieldset>
        </DialogBody>
      </div>
      <DialogFooter className="justify-between">
        {confirmingDiscard ? (
          <>
            <span role="alert" className="min-w-0 text-sm font-medium">
              {t("metadataEditor.discardPrompt")}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmingDiscard(false)}>
                {t("metadataEditor.keepEditing")}
              </Button>
              <Button variant="destructive" size="sm" onClick={onClose}>
                {t("metadataEditor.discard")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate text-xs text-muted-foreground" aria-live="polite">
              {dirty
                ? t("metadataEditor.unsavedSections", {
                    sections: changedSections.map((item) => sectionLabel(item.id)).join(" · "),
                  })
                : t("metadataEditor.noChanges")}
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" size="sm" disabled={saving} onClick={requestClose}>
                {t("content.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={readOnly || saving || !dirty}
                title={t("metadataEditor.saveShortcut")}
                onClick={() => void save()}
              >
                {saving ? t("common.saving") : t("content.save")}
              </Button>
            </div>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
