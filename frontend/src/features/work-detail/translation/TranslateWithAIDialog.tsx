import { AudioLines, ChevronDown, ChevronRight, Languages, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { TranslationReviewList } from "@/components/translation/TranslationReviewList";
import { useTranslationReviewActions } from "@/components/translation/useTranslationReviewActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { FloatingSelect } from "@/components/ui/floating-select";
import { Switch } from "@/components/ui/switch";
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
  type ASRService,
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
import { interfaceLyricsLanguage, modelTranslationTargets } from "@/lib/translationTargets";
import { LyricsTranslationMatrix } from "./LyricsTranslationMatrix";
import {
  activeLyricsCells,
  defaultLyricsPlan,
  directASRLanguage,
  lyricsRequestTargets,
  missingCount,
  requestEstimates,
  type LyricsPlan,
  type PlanTrack,
} from "./translateWithAIModel";

const categories: readonly TranslationCategory[] = ["title", "description", "tags", "files"];
const languageOrder = metadataTagNameLanguages.map(([language]) => language);
const pollMs = 4000;

type Tab = "translate" | "results";

/** Refusals that say what to change. */
const requestRefusals = new Set([
  "nothing_to_translate",
  "llm_not_ready",
  "llm_policy_blocked",
  "llm_unsupported_language_pair",
  "asr_not_ready",
  "asr_language_unsupported",
  "asr_origin_unknown",
  "asr_ffmpeg_unavailable",
  "llm_permission_changed",
]);

/**
 * Translates what one work lacks in the chosen languages: its title,
 * description and shared tag names, local file and folder display names, and
 * the lyrics of each local track. A track without lyrics can be transcribed
 * first by a speech recognition service. Each finished item is accepted at
 * once while auto-accept is on, and otherwise waits here and on the
 * Translation page for review; the results tab lists what is running,
 * stopped and applied.
 */
export function TranslateWithAIDialog({
  work,
  mediaWork,
  onClose,
  onChanged,
}: {
  work: WorkDetail;
  /** The work whose local files the detail shows, for display names and lyrics. */
  mediaWork: WorkDetail | null;
  onClose: () => void;
  /** Reloads the work after an accepted item changed it. */
  onChanged: () => Promise<void> | void;
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
  const [transcribe, setTranscribe] = useState(true);
  const [directASR, setDirectASR] = useState(true);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [plan, setPlan] = useState<TranslationPlan | null>(null);
  const [planError, setPlanError] = useState(false);
  const [providers, setProviders] = useState<LLMTranslationModel[] | null>(null);
  const [asrServices, setASRServices] = useState<ASRService[] | null>(null);
  const [choiceKey, setChoiceKey] = useState("");
  const [asrKey, setASRKey] = useState("");
  const [lyricsPlan, setLyricsPlan] = useState<LyricsPlan | null>(null);
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
    api
      .listASRServices()
      .then((result) => {
        setASRServices(result);
        setASRKey((current) => current || serviceModelChoices(result)[0]?.key || "");
      })
      .catch(() => setASRServices([]));
  }, [loadItems, work.id]);

  const running = items.some((item) => ["queued", "waiting_transcription", "requesting"].includes(item.state));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void loadItems();
      void loadPlan();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [loadItems, loadPlan, running]);

  const active = useMemo(() => activeLyricsCells(plan), [plan]);
  const transcribing = useMemo(() => new Set(plan?.transcribing ?? []), [plan?.transcribing]);
  const permissions = plan?.permissions ?? { metadata: false, files: false, lyrics: false };
  const asrChoices = serviceModelChoices(asrServices ?? []);
  const asrChoice = asrChoices.find((candidate) => candidate.key === asrKey) ?? null;
  const asrConfigured = asrChoices.length > 0;
  const canTranscribe = transcribe && asrConfigured && origin !== "";
  // Every missing cell starts chosen; a change of languages or switches starts over.
  const defaultPlan = useMemo(
    () => defaultLyricsPlan({ tracks, languages, origin, active, transcribe: canTranscribe, transcribing }),
    [active, canTranscribe, languages, origin, tracks, transcribing],
  );
  useEffect(() => setLyricsPlan(null), [defaultPlan]);
  const currentLyricsPlan = lyricsPlan ?? defaultPlan;
  const lyricsTargets = useMemo(
    () =>
      lyricsChosen && permissions.lyrics
        ? lyricsRequestTargets({ tracks, languages, plan: currentLyricsPlan, sourceFiles, active })
        : [],
    [active, currentLyricsPlan, languages, lyricsChosen, permissions.lyrics, sourceFiles, tracks],
  );
  const transcribedLanguages = [
    ...new Set(lyricsTargets.filter((target) => target.lyricsLocationId === 0).map((target) => target.targetLanguage)),
  ];
  const direct = directASR
    ? directASRLanguage(asrChoice?.service, asrChoice?.model, origin, transcribedLanguages)
    : null;
  const directOffered = directASRLanguage(asrChoice?.service, asrChoice?.model, origin, transcribedLanguages);
  const allowedCategories = categories.filter(
    (category) => chosenCategories.has(category) && (category === "files" ? permissions.files : permissions.metadata),
  );
  const estimates = requestEstimates(plan, allowedCategories, lyricsTargets);
  const total = estimates.reduce((sum, estimate) => sum + estimate.items, 0);
  const choices = serviceModelChoices(providers ?? []);
  const choice = choices.find((candidate) => candidate.key === choiceKey) ?? null;
  const modelTargets = modelTranslationTargets(choice?.service, choice?.model);
  const supports = (language: string) => modelTargets === null || modelTargets.includes(language);
  const needsLLM =
    allowedCategories.length > 0 ||
    lyricsTargets.some((target) => target.lyricsLocationId > 0) ||
    (transcribedLanguages.length > 0 && !direct);
  const tracksWithoutLyrics = tracks.filter((track) => track.lyrics.size === 0);
  const noLyricsAtAll = tracks.length > 0 && tracksWithoutLyrics.length === tracks.length;
  const unsupported = languages.filter((language) => !supports(language));
  const reviewCount = items.filter((item) => item.state === "ready").length;
  const languageName = (language: string) =>
    t(metadataTagNameLanguages.find(([value]) => value === language)?.[1] ?? language);

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
        asrProviderId: asrChoice?.service.id ?? "",
        asrModel: asrChoice?.model,
        directAsr: direct !== null,
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

  return (
    <Dialog onClose={onClose} size="2xl" dismissible={!submitting} marker="translate-with-ai">
      <DialogHeader
        title={t("aiTranslation.title")}
        description={work.title}
        icon={<Sparkles className="h-4 w-4" />}
        onClose={submitting ? undefined : onClose}
        closeLabel={t("content.close")}
      />
      <div role="tablist" aria-label={t("aiTranslation.title")} className="flex shrink-0 gap-1 border-b px-5">
        {(["translate", "results"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "-mb-px flex min-h-11 items-center gap-1.5 border-b-2 px-2 text-sm transition-colors",
              tab === value
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`aiTranslation.tabs.${value}`)}
            {value === "results" && reviewCount > 0 && (
              <span className="rounded-full bg-warning-surface px-1.5 py-px text-2xs tabular-nums text-warning-foreground">
                {reviewCount}
              </span>
            )}
          </button>
        ))}
      </div>
      {tab === "translate" ? (
        <DialogBody className="space-y-4">
          {noLyricsAtAll && permissions.lyrics && (
            <p className="rounded-md border border-info-border bg-info-surface px-3 py-2 text-sm text-info-foreground">
              {t("aiTranslation.noLyricsAtAll")}
            </p>
          )}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("aiTranslation.languages")}</legend>
            <div className="flex flex-wrap gap-2">
              {languageOrder.map((language) => {
                const chosen = languages.includes(language);
                return (
                  <button
                    key={language}
                    type="button"
                    aria-pressed={chosen}
                    disabled={submitting || (chosen && languages.length === 1)}
                    onClick={() => toggleLanguage(language)}
                    className={cn(
                      "inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      chosen ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {languageName(language)}
                    {language === origin && (
                      <span className="text-2xs text-info-foreground">{t("lyricsManager.original")}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {planError ? (
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
          ) : (
            <div className="app-scrollbar overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-max border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      {t("aiTranslation.category")}
                    </th>
                    {plan.languages.map((language) => (
                      <th key={language.language} scope="col" className="w-28 px-2 py-2 text-center font-medium">
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
                        {plan.languages.map((language) => {
                          const entry = language[category];
                          return (
                            <td key={language.language} className="px-2 py-2 text-center align-top">
                              <PlanCell
                                missing={missingCount(language, category)}
                                active={entry.active}
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
                  <tr className={cn(!permissions.lyrics && "opacity-60")}>
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <label className="flex items-start gap-2">
                        <Checkbox
                          className="mt-0.5"
                          checked={permissions.lyrics && lyricsChosen}
                          disabled={!permissions.lyrics || submitting || tracks.length === 0}
                          onCheckedChange={setLyricsChosen}
                        />
                        <span className="min-w-0">
                          <span className="block">{t("aiTranslation.categories.lyrics")}</span>
                          <span className="block text-xs text-muted-foreground">
                            {!permissions.lyrics
                              ? t("aiTranslation.noLyricsPermission")
                              : tracks.length === 0
                                ? t("aiTranslation.noLocalTracks")
                                : t("aiTranslation.lyricsHint")}
                          </span>
                        </span>
                      </label>
                    </th>
                    {plan.languages.map((language) => (
                      <td key={language.language} className="px-2 py-2 text-center align-top">
                        <PlanCell
                          missing={lyricsTargets.filter((target) => target.targetLanguage === language.language).length}
                          active={language.lyrics.length}
                          origin={false}
                        />
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {permissions.lyrics && lyricsChosen && tracks.length > 0 && (
            <section className="space-y-3" aria-label={t("aiTranslation.categories.lyrics")}>
              {tracksWithoutLyrics.length > 0 && (
                <div className="space-y-2 rounded-lg border px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm">
                      <AudioLines className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      {t("aiTranslation.tracksNeedTranscription", { count: tracksWithoutLyrics.length })}
                    </p>
                    <label className="flex items-center gap-2 text-sm">
                      {t("aiTranslation.transcribeFirst")}
                      <Switch
                        checked={canTranscribe}
                        disabled={submitting || !asrConfigured || origin === ""}
                        onCheckedChange={setTranscribe}
                        aria-label={t("aiTranslation.transcribeFirst")}
                      />
                    </label>
                  </div>
                  {!asrConfigured ? (
                    <p className="text-xs text-muted-foreground">
                      {t("aiTranslation.noASRService")}{" "}
                      <a
                        href="/settings?tab=services"
                        className="text-primary hover:underline"
                        onClick={(event) => {
                          event.preventDefault();
                          onClose();
                          window.history.pushState({}, "", "/settings?tab=services");
                          window.dispatchEvent(new Event(NAVIGATION_EVENT));
                        }}
                      >
                        {t("aiTranslation.openServiceSettings")}
                      </a>
                    </p>
                  ) : origin === "" ? (
                    <p className="text-xs text-muted-foreground">{t("aiTranslation.originUnknown")}</p>
                  ) : canTranscribe ? (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {direct
                          ? t("aiTranslation.directOutputNote", { language: languageName(direct) })
                          : t("aiTranslation.transcriptionKeepsOriginal", { language: languageName(origin) })}
                      </p>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-0 flex-1 basis-52 sm:max-w-72">
                          <div className="mb-1 text-xs font-medium text-muted-foreground">
                            {t("aiTranslation.asrService")}
                          </div>
                          <FloatingSelect
                            value={asrKey}
                            ariaLabel={t("aiTranslation.asrService")}
                            options={asrChoices.map(({ key, service, model }) => ({
                              value: key,
                              label: `${service.name} · ${model}`,
                            }))}
                            onValueChange={setASRKey}
                            disabled={submitting}
                          />
                        </div>
                        {directOffered && (
                          <label className="flex min-h-9 items-center gap-2 text-sm">
                            <Checkbox checked={directASR} disabled={submitting} onCheckedChange={setDirectASR} />
                            {t("aiTranslation.useDirectOutput", { language: languageName(directOffered) })}
                          </label>
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
              <button
                type="button"
                aria-expanded={lyricsOpen}
                onClick={() => setLyricsOpen((current) => !current)}
                className="flex min-h-9 items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
              >
                {lyricsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                {t("aiTranslation.chooseTracks")}
              </button>
              {lyricsOpen && (
                <LyricsTranslationMatrix
                  audio={entries.audio}
                  tracks={tracks}
                  sourceFiles={sourceFiles}
                  origin={origin}
                  targetLanguages={languages}
                  plan={currentLyricsPlan}
                  active={active}
                  transcribeAvailable={canTranscribe}
                  supports={supports}
                  disabled={submitting}
                  onPlanChange={setLyricsPlan}
                />
              )}
            </section>
          )}

          {needsLLM && (
            <div className="min-w-0 sm:max-w-80">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t("aiTranslation.llmModel")}</div>
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
                  <li key={estimate.language} className="flex flex-wrap justify-between gap-2">
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
              <p className="mt-1 text-xs text-muted-foreground">{t("aiTranslation.onlyMissing")}</p>
            </section>
          )}
        </DialogBody>
      ) : (
        <DialogBody className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t(plan?.autoAccept === false ? "aiTranslation.reviewIntro" : "aiTranslation.resultsIntro")}
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("aiTranslation.refresh")}
              title={t("aiTranslation.refresh")}
              onClick={() => void loadItems()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          {items.length === 0 ? (
            <p className="rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
              {t("aiTranslation.noResults")}
            </p>
          ) : (
            <>
              {(["review", "active", "attention", "history"] as const).map((mode) => {
                const shown = items.filter((item) =>
                  mode === "review"
                    ? item.state === "ready"
                    : mode === "active"
                      ? ["queued", "waiting_transcription", "requesting"].includes(item.state)
                      : mode === "attention"
                        ? ["failed", "uncertain", "invalid", "policy_blocked"].includes(item.state)
                        : item.state === "accepted",
                );
                if (shown.length === 0) return null;
                return (
                  <section key={mode} className="space-y-2" aria-label={t(`aiTranslation.reviewSections.${mode}`)}>
                    <h4 className="text-sm font-medium">{t(`aiTranslation.reviewSections.${mode}`)}</h4>
                    <TranslationReviewList
                      items={shown}
                      mode={mode}
                      busyIds={review.busyIds}
                      onAccept={(ids) => void review.accept(ids)}
                      onReject={(ids) => void review.reject(ids)}
                      onResend={(ids, acknowledge) => void review.resend(ids, acknowledge)}
                      renderLyricsPreview={(item) => (
                        <LyricsPreview
                          label={item.label}
                          loadKey={`translation:${item.id}`}
                          load={() => api.translationItemText(item.id, "result")}
                          durationSeconds={
                            audioByID.get(Number(item.subject))?.durationSeconds ?? item.durationSeconds ?? null
                          }
                        />
                      )}
                    />
                  </section>
                );
              })}
            </>
          )}
        </DialogBody>
      )}
      <DialogFooter className="justify-between">
        {tab === "translate" ? (
          <>
            <span className="mr-auto text-xs text-muted-foreground" role="status">
              {total > 0 ? t("aiTranslation.totalItems", { count: total }) : t("aiTranslation.nothingMissing")}
            </span>
            <Button variant="ghost" onClick={onClose} disabled={submitting}>
              {t("content.close")}
            </Button>
            <Button onClick={() => void submit()} disabled={submitting || total === 0 || (needsLLM && !choice)}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
              {t("aiTranslation.start", { count: total })}
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            {t("content.close")}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** What one language lacks in one category. */
function PlanCell({
  missing,
  active,
  origin,
  note,
}: {
  missing: number;
  active: number;
  origin: boolean;
  note?: string;
}) {
  const { t } = useTranslation();
  if (origin) return <span className="text-xs text-muted-foreground">{t("aiTranslation.originalNames")}</span>;
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      {missing > 0 ? (
        <span className="tabular-nums text-warning-foreground">
          {t("aiTranslation.missingCount", { count: missing })}
        </span>
      ) : (
        <span className="text-muted-foreground" title={t("aiTranslation.nothingMissing")}>
          —
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
