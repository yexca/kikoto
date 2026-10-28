import { AudioLines, Check, History, Languages, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useTranslationReviewActions } from "@/components/translation/useTranslationReviewActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { DialogTabs } from "@/components/ui/dialog-tabs";
import { FloatingSelect } from "@/components/ui/floating-select";
import { filterChipClassName, segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { lyricsManagerEntries } from "@/features/work-detail/lyrics/lyricsManagerModel";
import { LyricsPreview } from "@/features/work-detail/lyrics/LyricsPreview";
import {
  trackLyricsByLanguage,
  translationSourceFiles,
  workOriginLyricsLanguage,
} from "@/features/work-detail/lyrics/lyricsTaskModel";
import {
  ApiError,
  api,
  type LLMTranslationModel,
  type TranslationCategory,
  type TranslationItem,
  type TranslationPlan,
  type WorkDetail,
} from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { metadataTagNameLanguages } from "@/lib/metadataTagModel";
import { serviceModelChoices } from "@/lib/serviceModels";
import { cn } from "@/lib/tailwindClassNames";
import { interfaceLyricsLanguage, modelTranslationDirection, modelTranslationTargets } from "@/lib/translationTargets";
import { allLyricsLanguages } from "@/lib/lyricsLanguage";
import { LyricsTranslationMatrix, UnavailableMark } from "./LyricsTranslationMatrix";
import { TranslationResults } from "./TranslationResults";
import {
  activeLyricsCells,
  anyLyricsDirection,
  canTranslateLyrics,
  defaultLyricsPlan,
  lyricsCellOpen,
  lyricsFileLanguage,
  lyricsRequestTargets,
  missingCount,
  requestEstimates,
  resultsSection,
  type LyricsCellContext,
  type LyricsPlan,
  type PlanTrack,
} from "./translateWithAIModel";

const categories: readonly TranslationCategory[] = ["title", "description", "tags", "files"];
const languageOrder = metadataTagNameLanguages.map(([language]) => language);
const pollMs = 4000;

type Tab = "translate" | "lyrics" | "results";

/** Whether the lyrics follow every missing cell of the chosen languages, or the cells chosen one by one. */
type LyricsMode = "missing" | "custom";

/** Where applied items of a category can be changed or undone, outside this dialog. */
export type TranslateWithAIEditor = "title" | "description" | "files" | "lyrics" | "transcribe";

/** Refusals that say what to change. */
const requestRefusals = new Set([
  "nothing_to_translate",
  "llm_not_ready",
  "llm_policy_blocked",
  "llm_unsupported_language_pair",
  "llm_permission_changed",
]);

/**
 * Translates what one work lacks in the chosen languages: its title,
 * description and shared tag names, local file and folder display names, and
 * the lyrics of each local track. The translate tab sets each category
 * against the chosen languages; the lyrics tab sets each track against the
 * lyrics languages, translating from one of its lyrics files, and sends a
 * track without lyrics to Manage lyrics to be transcribed. Each finished item is accepted at
 * once while auto-accept is on, and otherwise waits for review; the results
 * tab records what was written and where to change it.
 */
export function TranslateWithAIDialog({
  work,
  mediaWork,
  onClose,
  onChanged,
  onOpenEditor,
}: {
  work: WorkDetail;
  /** The work whose local files the detail shows, for display names and lyrics. */
  mediaWork: WorkDetail | null;
  onClose: () => void;
  /** Reloads the work after an accepted item changed it. */
  onChanged: () => Promise<void> | void;
  /** Closes the dialog and opens where an applied category can be changed or undone. */
  onOpenEditor?: (editor: TranslateWithAIEditor) => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const origin = workOriginLyricsLanguage(work);
  const entries = useMemo(() => lyricsManagerEntries(mediaWork?.mediaItems ?? []), [mediaWork?.mediaItems]);
  const sourceFiles = useMemo(
    () => translationSourceFiles(mediaWork?.mediaItems ?? [], entries.lyrics),
    [entries.lyrics, mediaWork?.mediaItems],
  );
  const tracks = useMemo<PlanTrack[]>(
    () =>
      entries.audio.map((entry) => ({
        audioId: entry.mediaItemId,
        lyrics: trackLyricsByLanguage(entry, (id) => sourceFiles.has(id)),
      })),
    [entries.audio, sourceFiles],
  );
  const [tab, setTab] = useState<Tab>("translate");
  const [languages, setLanguages] = useState<string[]>(() => {
    const preferred = interfaceLyricsLanguage(i18n.resolvedLanguage);
    return [preferred === origin ? (languageOrder.find((language) => language !== origin) ?? preferred) : preferred];
  });
  const [chosenCategories, setChosenCategories] = useState<Set<TranslationCategory>>(() => new Set(categories));
  const [lyricsChosen, setLyricsChosen] = useState(true);
  const [plan, setPlan] = useState<TranslationPlan | null>(null);
  const [planError, setPlanError] = useState(false);
  const [providers, setProviders] = useState<LLMTranslationModel[] | null>(null);
  const [choiceKey, setChoiceKey] = useState("");
  const [lyricsMode, setLyricsMode] = useState<LyricsMode>("missing");
  const [customPlan, setCustomPlan] = useState<LyricsPlan>(() => ({ selection: new Map() }));
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState<TranslationItem[]>([]);

  const loadPlan = useCallback(async () => {
    try {
      setPlan(await api.translationPlan(work.id, languages));
      setPlanError(false);
    } catch {
      setPlanError(true);
    }
  }, [languages, work.id]);
  const loadItems = useCallback(async () => {
    try {
      const [review, active, attention, history] = await Promise.all([
        api.listTranslationItems("review", { workId: work.id }),
        api.listTranslationItems("active", { workId: work.id }),
        api.listTranslationItems("attention", { workId: work.id }),
        api.listTranslationItems("history", { workId: work.id }),
      ]);
      setItems([...review.items, ...active.items, ...attention.items, ...history.items]);
    } catch (error) {
      toast.notify(toastFromError(error, t("aiTranslation.reviewLoadFailed")));
    }
  }, [t, toast, work.id]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);
  useEffect(() => {
    void loadItems();
    api
      .listTranslationModels(work.id)
      .then((result) => {
        setProviders(result);
        setChoiceKey((current) => current || serviceModelChoices(result)[0]?.key || "");
      })
      .catch(() => setProviders([]));
  }, [loadItems, work.id]);

  const running = items.some((item) => resultsSection(item.state) === "active");
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void loadItems();
      void loadPlan();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [loadItems, loadPlan, running]);

  const active = useMemo(() => activeLyricsCells(plan), [plan]);
  const permissions = plan?.permissions ?? { metadata: false, files: false, lyrics: false };
  const choices = serviceModelChoices(providers ?? []);
  const choice = choices.find((candidate) => candidate.key === choiceKey) ?? null;
  // The work's text translates from its original language, and each track's
  // lyrics from the language of the file it reads.
  const modelTargets = modelTranslationTargets(choice?.service, choice?.model);
  const translatesText = (language: string) => modelTargets === null || modelTargets.includes(language);
  const direction = useMemo(
    () => modelTranslationDirection(choice?.service, choice?.model),
    [choice?.model, choice?.service],
  );
  const translates = direction ?? anyLyricsDirection;
  // Until a cell is chosen by hand, every missing cell the model can translate is chosen.
  const defaultPlan = useMemo(
    () => defaultLyricsPlan({ tracks, languages, origin, active, translates }),
    [active, languages, origin, tracks, translates],
  );
  const currentLyricsPlan = lyricsMode === "custom" ? customPlan : defaultPlan;
  const cellContext: LyricsCellContext = { plan: currentLyricsPlan, origin, active, translates };
  // The lyrics row counts what the tracks would send even while the row is not chosen.
  const plannedLyrics = useMemo(
    () =>
      permissions.lyrics
        ? lyricsRequestTargets({ tracks, languages, plan: currentLyricsPlan, sourceFiles, active, translates })
        : [],
    [active, currentLyricsPlan, languages, permissions.lyrics, sourceFiles, tracks, translates],
  );
  const lyricsTargets = lyricsChosen ? plannedLyrics : [];
  const allowedCategories = categories.filter(
    (category) => chosenCategories.has(category) && (category === "files" ? permissions.files : permissions.metadata),
  );
  const estimates = requestEstimates(plan, allowedCategories, lyricsTargets, translatesText);
  const total = estimates.reduce((sum, estimate) => sum + estimate.items, 0);
  const needsLLM = allowedCategories.length > 0 || lyricsTargets.length > 0;
  const tracksWithoutLyrics = tracks.filter((track) => track.lyrics.size === 0);
  const noLyricsAtAll = tracks.length > 0 && tracksWithoutLyrics.length === tracks.length;
  // Languages the model translates into from no source at all.
  const unsupported = languages.filter((language) => !translates(allLyricsLanguages, language));
  // Fallback lyrics have no declared language, so a model limited to declared
  // directions is sent them without knowing what they are in.
  const trackByID = new Map(tracks.map((track) => [track.audioId, track]));
  const unknownSources =
    direction === null
      ? 0
      : new Set(
          plannedLyrics
            .filter((target) => {
              const track = trackByID.get(target.audioMediaItemId);
              const row = currentLyricsPlan.selection.get(target.audioMediaItemId);
              return track && row && lyricsFileLanguage(track, row.source) === allLyricsLanguages;
            })
            .map((target) => target.audioMediaItemId),
        ).size;
  const chooseLyricsMode = (mode: LyricsMode) => {
    if (mode === "custom") setCustomPlan(currentLyricsPlan);
    setLyricsMode(mode);
  };
  const editLyricsPlan = (next: LyricsPlan) => {
    setCustomPlan(next);
    setLyricsMode("custom");
  };
  const lyricsAvailable = permissions.lyrics && tracks.length > 0;
  const lyricsTracksChosen = new Set(plannedLyrics.map((target) => target.audioMediaItemId)).size;
  const needsAction = items.filter((item) => ["review", "attention"].includes(resultsSection(item.state) ?? "")).length;
  const languageName = (language: string) =>
    t(metadataTagNameLanguages.find(([value]) => value === language)?.[1] ?? language);
  const shownTab = tab === "lyrics" && !lyricsAvailable ? "translate" : tab;

  const submit = async () => {
    if (total === 0) return;
    setSubmitting(true);
    try {
      const result = await api.requestTranslation(work.id, {
        languages,
        categories: allowedCategories,
        providerId: choice?.service.id ?? "",
        model: choice?.model,
        lyrics: lyricsTargets,
      });
      toast.success(
        t(plan?.autoAccept === false ? "aiTranslation.queued" : "aiTranslation.queuedApply", { count: result.items }),
      );
      setTab("results");
      await Promise.all([loadItems(), loadPlan()]);
    } catch (error) {
      toast.notify(
        error instanceof ApiError && requestRefusals.has(error.code)
          ? { kind: "error", message: t(`aiTranslation.refusals.${error.code}`) }
          : toastFromError(error, t("aiTranslation.requestFailed")),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const review = useTranslationReviewActions({
    onDone: async () => {
      await Promise.all([loadItems(), loadPlan()]);
    },
    onAccepted: onChanged,
  });

  const toggleLanguage = (language: string) =>
    setLanguages((current) =>
      current.includes(language)
        ? current.filter((value) => value !== language)
        : languageOrder.filter((value) => value === language || current.includes(value)),
    );
  const audioByID = new Map(entries.audio.map((entry) => [entry.mediaItemId, entry]));
  const navigate = (path: string) => {
    onClose();
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  const openServiceSettings = () => navigate("/settings?tab=services");
  const openTranscribe = onOpenEditor
    ? () => {
        onClose();
        onOpenEditor("transcribe");
      }
    : undefined;
  const settingsLink = (
    <a
      href="/settings?tab=services"
      className="text-primary hover:underline"
      onClick={(event) => {
        event.preventDefault();
        openServiceSettings();
      }}
    >
      {t("aiTranslation.openServiceSettings")}
    </a>
  );

  const languagePicker = (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{t("aiTranslation.languages")}</legend>
      <div className="flex flex-wrap gap-1.5">
        {languageOrder.map((language) => {
          const chosen = languages.includes(language);
          return (
            <button
              key={language}
              type="button"
              aria-pressed={chosen}
              disabled={submitting || (chosen && languages.length === 1)}
              onClick={() => toggleLanguage(language)}
              className={filterChipClassName(chosen, "h-9 disabled:cursor-default sm:h-8")}
            >
              {chosen && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
              {languageName(language)}
              {language === origin && <span className="font-normal opacity-70">· {t("lyricsManager.original")}</span>}
            </button>
          );
        })}
      </div>
    </fieldset>
  );

  const planState = planError ? (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-error-border bg-error-surface px-3 py-2 text-sm text-error-foreground"
    >
      {t("aiTranslation.planFailed")}
      <Button size="sm" variant="outline" onClick={() => void loadPlan()}>
        <RefreshCw className="h-4 w-4" />
        {t("common.retry")}
      </Button>
    </div>
  ) : !plan ? (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {t("aiTranslation.loadingPlan")}
    </p>
  ) : null;

  return (
    <Dialog onClose={onClose} size="workspace" dismissible={!submitting} marker="translate-with-ai">
      <DialogHeader
        title={t("aiTranslation.title")}
        description={work.title}
        icon={<Sparkles className="h-4 w-4" />}
        onClose={submitting ? undefined : onClose}
        closeLabel={t("content.close")}
        className="border-b-0 pb-1"
      />
      <DialogTabs
        tabs={[
          { value: "translate", icon: Languages, label: t("aiTranslation.tabs.translate") },
          ...(lyricsAvailable
            ? [
                {
                  value: "lyrics" as const,
                  icon: AudioLines,
                  label: t("aiTranslation.tabs.lyrics"),
                  count: lyricsChosen ? lyricsTracksChosen : 0,
                },
              ]
            : []),
          {
            value: "results",
            icon: History,
            label: t("aiTranslation.tabs.results"),
            count: needsAction,
            countTone: "warning",
            busy: running,
          },
        ]}
        value={shownTab}
        label={t("aiTranslation.title")}
        onChange={setTab}
      />
      {shownTab === "translate" ? (
        <DialogBody key="translate" className="space-y-4">
          {languagePicker}
          {planState ?? (
            <div className="app-scrollbar overflow-x-auto rounded-lg border bg-card">
              {/* Category names wrap so the language counts stay in view on phones. */}
              <table
                className="w-full border-collapse text-sm"
                style={{ minWidth: `${10 + (plan?.languages.length ?? 0) * 6}rem` }}
              >
                <thead>
                  <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      {t("aiTranslation.category")}
                    </th>
                    {plan?.languages.map((language) => (
                      <th
                        key={language.language}
                        scope="col"
                        className="w-24 px-2 py-2 text-center font-medium sm:w-28"
                      >
                        {languageName(language.language)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {categories.map((category) => {
                    const allowed = category === "files" ? permissions.files : permissions.metadata;
                    return (
                      <tr key={category} className={cn(!allowed && "opacity-60")}>
                        <th scope="row" className="px-3 py-2 text-left font-normal">
                          <label className="flex items-start gap-2">
                            <Checkbox
                              className="mt-0.5"
                              checked={allowed && chosenCategories.has(category)}
                              disabled={!allowed || submitting}
                              onCheckedChange={(checked) =>
                                setChosenCategories((current) => {
                                  const next = new Set(current);
                                  if (checked) next.add(category);
                                  else next.delete(category);
                                  return next;
                                })
                              }
                            />
                            <span className="min-w-0">
                              <span className="block">{t(`aiTranslation.categories.${category}`)}</span>
                              <span className="block text-xs text-muted-foreground">
                                {!allowed
                                  ? t(
                                      category === "files"
                                        ? "aiTranslation.noFilesPermission"
                                        : "aiTranslation.noMetadataPermission",
                                    )
                                  : category === "tags"
                                    ? t("aiTranslation.tagsShared")
                                    : category === "files"
                                      ? t("aiTranslation.filesHint")
                                      : null}
                              </span>
                            </span>
                          </label>
                        </th>
                        {plan?.languages.map((language) => {
                          const entry = language[category];
                          return (
                            <td key={language.language} className="px-2 py-2 text-center align-top">
                              <PlanCell
                                missing={missingCount(language, category)}
                                complete={missingCount(language, category) === 0}
                                unavailable={!translatesText(language.language)}
                                active={entry.active}
                                sent={allowed && chosenCategories.has(category)}
                                origin={category === "files" && language.language === origin}
                                note={
                                  category === "tags" && entry.affectedWorks
                                    ? t("aiTranslation.affectsWorks", { count: entry.affectedWorks })
                                    : category === "tags" && entry.otherWorks
                                      ? t("aiTranslation.inOtherTasks", { count: entry.otherWorks })
                                      : category === "files" && entry.skipped
                                        ? t("aiTranslation.namesSkipped", { count: entry.skipped })
                                        : undefined
                                }
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  <tr className={cn(!lyricsAvailable && "opacity-60")}>
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <div className="flex items-start gap-2">
                        <Checkbox
                          className="mt-0.5"
                          checked={lyricsAvailable && lyricsChosen}
                          disabled={!lyricsAvailable || submitting}
                          aria-labelledby="translate-with-ai-lyrics"
                          onCheckedChange={setLyricsChosen}
                        />
                        <span className="min-w-0">
                          <span id="translate-with-ai-lyrics" className="block">
                            {t("aiTranslation.categories.lyrics")}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {!permissions.lyrics
                              ? t("aiTranslation.noLyricsPermission")
                              : tracks.length === 0
                                ? t("aiTranslation.noLocalTracks")
                                : t("aiTranslation.lyricsHint")}
                          </span>
                          {lyricsAvailable && (
                            <button
                              type="button"
                              className="mt-0.5 inline-flex min-h-8 items-center text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={() => setTab("lyrics")}
                            >
                              {t("aiTranslation.chooseTracks", { chosen: lyricsTracksChosen, total: tracks.length })}
                            </button>
                          )}
                        </span>
                      </div>
                    </th>
                    {plan?.languages.map((language) => {
                      // Missing lyrics count what is chosen; cells the model
                      // cannot translate make the language unavailable only
                      // when no track can create it.
                      const planned = plannedLyrics.filter(
                        (target) => target.targetLanguage === language.language,
                      ).length;
                      const missing = tracks.some((track) => canTranslateLyrics(track, language.language, active));
                      const open = tracks.some((track) => lyricsCellOpen(track, language.language, cellContext));
                      return (
                        <td key={language.language} className="px-2 py-2 text-center align-top">
                          <PlanCell
                            missing={planned}
                            complete={!missing}
                            unavailable={!open}
                            noneChosen={planned === 0}
                            active={language.lyrics.length}
                            sent={lyricsAvailable && lyricsChosen}
                            origin={false}
                          />
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {needsLLM && (
            <div className="min-w-0">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t("aiTranslation.llmModel")}</div>
              <div className="sm:max-w-80">
                <FloatingSelect
                  value={choiceKey}
                  ariaLabel={t("aiTranslation.llmModel")}
                  options={choices.map(({ key, service, model }) => ({
                    value: key,
                    label: `${service.name} · ${model}`,
                  }))}
                  onValueChange={setChoiceKey}
                  triggerLabel={
                    providers === null
                      ? t("aiTranslation.loading")
                      : choices.length === 0
                        ? t("aiTranslation.noLLMService")
                        : undefined
                  }
                  disabled={submitting || choices.length === 0}
                />
              </div>
              {providers !== null && choices.length === 0 && <p className="mt-1 text-xs">{settingsLink}</p>}
              {unsupported.length > 0 && (
                <p className="mt-1 text-xs text-warning-foreground">
                  {t("aiTranslation.unsupportedLanguages", { languages: unsupported.map(languageName).join(", ") })}
                </p>
              )}
            </div>
          )}

          {plan && (
            <section
              aria-label={t("aiTranslation.estimate")}
              className="rounded-lg border bg-muted/25 px-3 py-2 text-sm"
            >
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t("aiTranslation.estimate")}</h4>
              <ul className="space-y-0.5">
                {estimates.map((estimate) => (
                  <li key={estimate.language} className="flex flex-wrap justify-between gap-x-2">
                    <span>{languageName(estimate.language)}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {t("aiTranslation.estimateLine", {
                        items: estimate.items,
                        characters: estimate.characters,
                        tracks: estimate.lyricsTracks,
                      })}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(plan.autoAccept ? "aiTranslation.appliesAtOnce" : "aiTranslation.waitsForReview")}{" "}
                {t("aiTranslation.onlyMissing")}
              </p>
            </section>
          )}
        </DialogBody>
      ) : shownTab === "lyrics" ? (
        <DialogBody key="lyrics" className="space-y-4">
          {languagePicker}
          {!lyricsChosen && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              {t("aiTranslation.lyricsNotChosen")}
              <Button size="sm" variant="outline" disabled={submitting} onClick={() => setLyricsChosen(true)}>
                {t("aiTranslation.chooseLyrics")}
              </Button>
            </div>
          )}
          {tracksWithoutLyrics.length > 0 && (
            <div
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2",
                noLyricsAtAll && "border-info-border bg-info-surface",
              )}
            >
              <p className={cn("flex items-start gap-2 text-sm", noLyricsAtAll && "text-info-foreground")}>
                <AudioLines className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {noLyricsAtAll
                  ? t("aiTranslation.noLyricsAtAll")
                  : t("aiTranslation.tracksWithoutLyrics", { count: tracksWithoutLyrics.length })}
              </p>
              {openTranscribe && (
                <Button size="sm" variant="outline" disabled={submitting} onClick={openTranscribe}>
                  {t("aiTranslation.openTranscribe")}
                </Button>
              )}
            </div>
          )}
          {planState ?? (
            <div className={cn("space-y-2", !lyricsChosen && "pointer-events-none opacity-60")}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div role="radiogroup" aria-label={t("aiTranslation.lyricsMode")} className={segmentedListClassName()}>
                  {(["missing", "custom"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="radio"
                      aria-checked={lyricsMode === mode}
                      disabled={submitting || !lyricsChosen}
                      onClick={() => chooseLyricsMode(mode)}
                      className={segmentedItemClassName(lyricsMode === mode)}
                    >
                      {t(`aiTranslation.lyricsModes.${mode}`)}
                    </button>
                  ))}
                </div>
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {t(lyricsMode === "custom" ? "aiTranslation.lyricsCustomHint" : "aiTranslation.lyricsMissingHint")}
                </p>
              </div>
              {unknownSources > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("aiTranslation.unknownLyricsSource", { count: unknownSources })}
                </p>
              )}
              <LyricsTranslationMatrix
                audio={entries.audio}
                tracks={tracks}
                sourceFiles={sourceFiles}
                targetLanguages={languages}
                context={cellContext}
                disabled={submitting || !lyricsChosen}
                onPlanChange={editLyricsPlan}
              />
            </div>
          )}
        </DialogBody>
      ) : (
        <DialogBody key="results">
          <TranslationResults
            items={items}
            autoAccept={plan?.autoAccept ?? null}
            busyIds={review.busyIds}
            onRefresh={() => void loadItems()}
            onAccept={(ids) => void review.accept(ids)}
            onReject={(ids) => void review.reject(ids)}
            onResend={(ids, acknowledge) => void review.resend(ids, acknowledge)}
            onOpen={(group) => {
              if (group === "tags") return permissions.metadata ? () => navigate("/metadata?view=tags") : undefined;
              if (!onOpenEditor) return undefined;
              return () => {
                onClose();
                onOpenEditor(group);
              };
            }}
            renderLyricsPreview={(item) => (
              <LyricsPreview
                label={item.label}
                loadKey={`translation:${item.id}`}
                load={() => api.translationItemText(item.id, "result")}
                durationSeconds={audioByID.get(Number(item.subject))?.durationSeconds ?? item.durationSeconds ?? null}
              />
            )}
          />
        </DialogBody>
      )}
      <DialogFooter className="justify-between">
        {shownTab === "results" ? (
          <Button variant="ghost" onClick={onClose}>
            {t("content.close")}
          </Button>
        ) : (
          <>
            <span className="mr-auto text-xs text-muted-foreground" role="status">
              {total > 0
                ? t("aiTranslation.totalItems", { count: total })
                : unsupported.length > 0
                  ? t("aiTranslation.nothingTranslatable")
                  : t("aiTranslation.nothingMissing")}
            </span>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              {t("content.close")}
            </Button>
            <Button onClick={() => void submit()} disabled={submitting || total === 0 || (needsLLM && !choice)}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
              {t("aiTranslation.start", { count: total })}
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * What one language lacks in one category: nothing, what is sent, or × when
 * the model cannot translate it. Dimmed while the category is not sent.
 */
function PlanCell({
  missing,
  complete,
  unavailable,
  noneChosen = false,
  active,
  sent,
  origin,
  note,
}: {
  /** What is sent. */
  missing: number;
  /** Whether nothing is missing. */
  complete: boolean;
  /** Whether the chosen model cannot translate what is missing. */
  unavailable: boolean;
  /** Whether what is missing is left out cell by cell. */
  noneChosen?: boolean;
  active: number;
  sent: boolean;
  origin: boolean;
  note?: string;
}) {
  const { t } = useTranslation();
  if (origin) return <span className="text-xs text-muted-foreground">{t("aiTranslation.originalNames")}</span>;
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      {complete ? (
        <span className="text-success-foreground" title={t("aiTranslation.nothingMissing")}>
          <Check className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">{t("aiTranslation.nothingMissing")}</span>
        </span>
      ) : unavailable ? (
        <UnavailableMark />
      ) : noneChosen ? (
        <span className="text-xs text-muted-foreground">{t("aiTranslation.noneChosen")}</span>
      ) : (
        <span className={cn("tabular-nums", sent ? "text-warning-foreground" : "text-muted-foreground")}>
          {t("aiTranslation.missingCount", { count: missing })}
        </span>
      )}
      {active > 0 && (
        <Badge variant="info" className="px-1.5 py-0 text-2xs">
          {t("aiTranslation.activeCount", { count: active })}
        </Badge>
      )}
      {note && <span className="text-2xs text-muted-foreground">{note}</span>}
    </span>
  );
}
