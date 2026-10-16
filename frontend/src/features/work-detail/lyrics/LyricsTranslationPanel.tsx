import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Cloud,
  Columns3,
  FileText,
  Folder,
  Languages,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { contentClassBadges } from "@/components/content/ContentAssessment";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import {
  groupAudioByFolder,
  type LyricsManagerAudio,
  type LyricsManagerFile,
} from "@/features/work-detail/lyrics/lyricsManagerModel";
import { ContentRatingButton, ServiceChoiceLabel } from "@/features/work-detail/lyrics/ContentRatingCheck";
import { serviceReceives, type ContentClass } from "@/features/work-detail/lyrics/contentRatingModel";
import { LyricsNote } from "@/features/work-detail/lyrics/LyricsNote";
import { LyricsPreview } from "@/features/work-detail/lyrics/LyricsPreview";
import {
  chooseTranslationSource,
  toggleTranslationColumn,
  toggleTranslationTarget,
  trackLyricsByLanguage,
  translationJobs,
  translationSourceFiles,
  whenLLMFree,
  workOriginLyricsLanguage,
  type TranslationSelection,
} from "@/features/work-detail/lyrics/lyricsTaskModel";
import {
  ApiError,
  api,
  type LLMAssessment,
  type LLMLyricsTranslation,
  type LLMLyricsTranslationState,
  type LLMTranslationModel,
  type WorkDetail,
} from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";
import { serviceModelChoices } from "@/lib/serviceModels";
import { cn } from "@/lib/tailwindClassNames";
import { modelTranslationTargets } from "@/lib/translationTargets";

const activeStates: ReadonlySet<LLMLyricsTranslationState> = new Set(["pending", "requesting"]);
const reviewStates: ReadonlySet<LLMLyricsTranslationState> = new Set(["ready", "publishing"]);
const stoppedStates: ReadonlySet<LLMLyricsTranslationState> = new Set(["failed", "invalid", "cancelled"]);
const pollMs = 4000;

const stateBadges: Record<LLMLyricsTranslationState, BadgeProps["variant"]> = {
  pending: "secondary",
  requesting: "info",
  failed: "error",
  uncertain: "error",
  invalid: "error",
  cancelled: "secondary",
  ready: "warning",
  expired: "secondary",
  rejected: "secondary",
  publishing: "warning",
  accepted: "success",
};

const ratingDots: Record<ContentClass, string> = {
  safe: "bg-success",
  sensitive: "bg-warning",
  restricted: "bg-warning",
  unknown: "bg-error",
  blocked: "bg-error",
};

const knownFailures = new Set([
  "upstream_rejected",
  "endpoint_unavailable",
  "source_temporarily_unavailable",
  "content_or_endpoint_unavailable",
  "translation_input_changed",
  "translation_boundary_changed",
  "permission_changed",
  "provider_changed",
  "policy_changed",
  "invalid_lyrics_output",
  "translation_output_too_large",
  "unsupported_language_pair",
  "service_not_ready",
  "service_start_failed",
  "service_out_of_memory",
]);

/** Refusals that say what to change, rather than that starting failed. */
const startRefusals = new Set([
  "llm_policy_blocked",
  "llm_not_ready",
  "llm_lyrics_scope",
  "llm_lyrics_format",
  "llm_input_too_large",
  "llm_remote_lyrics_disabled",
  "llm_unsupported_language_pair",
]);

type Rating = { status: "checking" | "failed" } | { status: "done"; assessment: LLMAssessment };

/** A track as the matrix shows it: its lyrics file per language. */
type MatrixTrack = { audioId: number; entry: LyricsManagerAudio; lyrics: ReadonlyMap<string, number> };

/**
 * Shows which languages each local track has lyrics in, and translates the
 * chosen tracks into the languages they lack with an LLM provider. Each
 * translation reads one lyrics file of the track, keeps its timing, and waits
 * here for review before it joins the track's lyrics in the target language.
 */
export function LyricsTranslationPanel({
  work,
  audio,
  lyrics,
  closeDisabled,
  onClose,
  onPublished,
}: {
  work: WorkDetail;
  audio: LyricsManagerAudio[];
  lyrics: LyricsManagerFile[];
  closeDisabled: boolean;
  onClose: () => void;
  /** Reloads the work after a translation became a lyrics file. */
  onPublished: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const origin = workOriginLyricsLanguage(work);
  const sourceFiles = useMemo(() => translationSourceFiles(work.mediaItems, lyrics), [lyrics, work.mediaItems]);
  const tracks = useMemo<MatrixTrack[]>(
    () =>
      audio.map((entry) => ({
        audioId: entry.mediaItemId,
        entry,
        // Only lyrics files the server can read count for a track.
        lyrics: trackLyricsByLanguage(entry, (id) => sourceFiles.has(id)),
      })),
    [audio, sourceFiles],
  );
  const [providers, setProviders] = useState<LLMTranslationModel[] | null>(null);
  const [translations, setTranslations] = useState<LLMLyricsTranslation[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const [selection, setSelection] = useState<TranslationSelection>(new Map());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  // A provider and one of its enabled models, as a serviceModelKey.
  const [choiceKey, setChoiceKey] = useState("");
  const [ratings, setRatings] = useState<ReadonlyMap<string, Rating>>(new Map());
  const [ratingProgress, setRatingProgress] = useState<{ done: number; total: number } | null>(null);
  const [submitting, setSubmitting] = useState<{ done: number; total: number } | null>(null);
  const [busyID, setBusyID] = useState<number | null>(null);
  const [previewID, setPreviewID] = useState<number | null>(null);
  const audioByID = useMemo(() => new Map(audio.map((entry) => [entry.mediaItemId, entry])), [audio]);
  const fileByLocation = useMemo(
    () => new Map([...sourceFiles.values()].map((file) => [file.locationId, file])),
    [sourceFiles],
  );

  const load = useCallback(async () => {
    try {
      setTranslations(await api.listLyricsTranslations(work.id));
      setListState("ready");
    } catch (error) {
      setListState((current) => (current === "ready" ? current : "failed"));
      toast.notify(toastFromError(error, t("lyricsTranslation.loadFailed")));
    }
  }, [t, toast, work.id]);

  useEffect(() => {
    void load();
    api
      .listTranslationModels(work.id)
      .then((result) => {
        setProviders(result);
        setChoiceKey((current) => current || serviceModelChoices(result)[0]?.key || "");
      })
      .catch((error) => {
        setProviders([]);
        toast.notify(toastFromError(error, t("lyricsTranslation.providersFailed")));
      });
  }, [load, t, toast, work.id]);

  const active = translations.some((item) => activeStates.has(item.state));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const choices = serviceModelChoices(providers ?? []);
  const choice = choices.find((candidate) => candidate.key === choiceKey) ?? null;
  const provider = choice?.service ?? null;
  const targets = modelTranslationTargets(choice?.service, choice?.model);
  const supports = (language: string) => targets === null || targets.includes(language);
  const noProvider = providers !== null && providers.length === 0;
  const columns = lyricsLanguages.filter(([language]) => !hidden.has(language));

  // The newest translation of each track and target that is running or waiting for review.
  const openTasks = new Map<string, LLMLyricsTranslation>();
  for (const item of translations) {
    const key = `${item.audioMediaItemId}:${item.targetLanguage}`;
    if (!openTasks.has(key) && (activeStates.has(item.state) || reviewStates.has(item.state))) openTasks.set(key, item);
  }
  const awaitingReview = translations.filter((item) => item.state === "ready").length;
  const selectable = (track: MatrixTrack, language: string) =>
    language !== allLyricsLanguages &&
    !track.lyrics.has(language) &&
    track.lyrics.size > 0 &&
    supports(language) &&
    !openTasks.has(`${track.audioId}:${language}`);
  const selectableTracks = (language: string) =>
    tracks.filter((track) => selectable(track, language)).map(({ audioId, lyrics }) => ({ audioId, lyrics }));

  const jobs = translationJobs(selection, tracks).filter(
    (job) => supports(job.targetLanguage) && !openTasks.has(`${job.audioMediaItemId}:${job.targetLanguage}`),
  );
  const ratingKey = (lyricsMediaItemId: number, audioId: number) =>
    `${sourceFiles.get(lyricsMediaItemId)?.locationId ?? 0}:${audioId}`;
  const ratingOf = (lyricsMediaItemId: number, audioId: number) => ratings.get(ratingKey(lyricsMediaItemId, audioId));
  const excluded = provider
    ? jobs.filter((job) => {
        const rating = ratingOf(job.lyricsMediaItemId, job.audioMediaItemId);
        return rating?.status === "done" && !serviceReceives(rating.assessment.class, provider);
      }).length
    : 0;

  const checkRatings = async () => {
    // Every lyrics file shown in the matrix, once per track it is read for.
    const inputs = new Map<string, { locationId: number; audioId: number }>();
    for (const track of tracks) {
      for (const [language] of columns) {
        const id = track.lyrics.get(language);
        const file = id === undefined ? undefined : sourceFiles.get(id);
        if (file)
          inputs.set(`${file.locationId}:${track.audioId}`, { locationId: file.locationId, audioId: track.audioId });
      }
    }
    const pending = [...inputs.entries()];
    if (pending.length === 0) return;
    let done = 0;
    let failed = 0;
    setRatingProgress({ done, total: pending.length });
    setRatings((current) => {
      const next = new Map(current);
      for (const [key] of pending) next.set(key, { status: "checking" });
      return next;
    });
    // A check holds one of the server's few LLM request slots, so files are checked one at a time.
    for (const [key, input] of pending) {
      let rating: Rating;
      try {
        const result = await whenLLMFree(() =>
          api.precheckWork(work.id, {
            fields: ["lyrics"],
            lyricsLocationId: input.locationId,
            audioMediaItemId: input.audioId,
          }),
        );
        rating = { status: "done", assessment: result.assessment };
      } catch {
        failed++;
        rating = { status: "failed" };
      }
      done++;
      setRatings((current) => new Map(current).set(key, rating));
      setRatingProgress({ done, total: pending.length });
    }
    setRatingProgress(null);
    if (failed > 0) toast.notify({ kind: "error", message: t("lyricsTranslation.ratingFailed", { count: failed }) });
  };

  const start = async () => {
    if (jobs.length === 0 || !choice) return;
    let queued = 0;
    let joined = 0;
    let lastRun = 0;
    setSubmitting({ done: 0, total: jobs.length });
    try {
      for (const [index, job] of jobs.entries()) {
        const file = sourceFiles.get(job.lyricsMediaItemId);
        if (!file) continue;
        const { runs } = await api.queueTranslations([work.primaryCode], {
          providerId: choice.service.id,
          model: choice.model,
          targetLanguage: job.targetLanguage,
          fields: ["lyrics"],
          lyricsLocationId: file.locationId,
          audioMediaItemId: job.audioMediaItemId,
        });
        const run = runs[0];
        if (run?.deduplicated) joined++;
        else queued++;
        if (run) lastRun = run.runId;
        setSubmitting({ done: index + 1, total: jobs.length });
      }
      setSelection(new Map());
    } catch (error) {
      toast.notify(
        error instanceof ApiError && startRefusals.has(error.code)
          ? { kind: "error", message: t(`lyricsTranslation.errors.${error.code}`) }
          : toastFromError(error, t("lyricsTranslation.startFailed")),
      );
    } finally {
      setSubmitting(null);
    }
    if (queued + joined > 0) {
      toast.notify({
        kind: queued > 0 ? "success" : "info",
        message:
          queued > 0
            ? t("lyricsTranslation.queuedCount", { count: queued }) +
              (joined > 0 ? ` ${t("lyricsTranslation.joinedCount", { count: joined })}` : "")
            : t("lyricsTranslation.joinedCount", { count: joined }),
        ...(lastRun ? { actionLabel: t("notifications.openActivity"), onAction: () => openActivityRun(lastRun) } : {}),
      });
    }
    await load();
  };

  const act = async (item: LLMLyricsTranslation, action: "accept" | "discard" | "resend") => {
    setBusyID(item.taskId);
    try {
      if (action === "accept") {
        if (item.state === "publishing") await api.publishTranslatedLyrics(item.previewId!);
        else await api.applyTranslation(work.id, item.previewId!);
        toast.success(t("lyricsTranslation.accepted"));
        await onPublished();
      } else if (action === "discard") {
        await api.rejectTranslation(work.id, item.previewId!);
        toast.success(t("lyricsTranslation.discarded"));
      } else {
        await api.resubmitUncertainTranslation(item.runId);
        toast.success(t("lyricsTranslation.resent"));
      }
      setPreviewID(null);
    } catch (error) {
      toast.notify(toastFromError(error, t(`lyricsTranslation.${action}Failed`)));
    } finally {
      setBusyID(null);
      await load();
    }
  };

  const languageName = (value: string) =>
    t(lyricsLanguages.find(([token]) => token === value)?.[1] ?? "lyricsTranslation.unknownLanguage");
  const providerOptions: FloatingSelectOption[] = choices.map(({ key, service, model }) => {
    const rated = jobs.flatMap((job) => {
      const rating = ratingOf(job.lyricsMediaItemId, job.audioMediaItemId);
      return rating?.status === "done" ? [rating.assessment.class] : [];
    });
    return {
      value: key,
      label: (
        <ServiceChoiceLabel
          name={`${service.name} · ${model}`}
          excluded={rated.some((contentClass) => !serviceReceives(contentClass, service))}
        />
      ),
    };
  });
  const ratedClasses = new Map<ContentClass, number>();
  for (const rating of ratings.values()) {
    if (rating.status === "done") {
      ratedClasses.set(rating.assessment.class, (ratedClasses.get(rating.assessment.class) ?? 0) + 1);
    }
  }
  const groups = groupAudioByFolder(audio);
  const trackByID = new Map(tracks.map((track) => [track.audioId, track]));
  const working = submitting !== null;
  const hasLyrics = tracks.some((track) => track.lyrics.size > 0);

  return (
    <>
      <DialogBody className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("lyricsTranslation.intro")}</p>
        {noProvider && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            {t("lyricsTranslation.noProvider")}
          </p>
        )}
        {!hasLyrics ? (
          <LyricsNote icon={<Languages aria-hidden="true" />}>{t("lyricsTranslation.noLyrics")}</LyricsNote>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <MatrixLegend />
              <div className="flex flex-wrap items-center gap-2">
                {ratedClasses.size > 0 && (
                  <span className="flex flex-wrap items-center gap-1" aria-live="polite">
                    {[...ratedClasses.entries()].map(([contentClass, count]) => (
                      <Badge
                        key={contentClass}
                        variant={contentClassBadges[contentClass]}
                        className="px-1.5 py-0 text-2xs"
                      >
                        {t(`contentRating.classes.${contentClass}`)} {count}
                      </Badge>
                    ))}
                  </span>
                )}
                <ContentRatingButton
                  checking={ratingProgress !== null}
                  checked={ratedClasses.size > 0}
                  progress={ratingProgress}
                  onCheck={() => void checkRatings()}
                />
                <LanguageColumnsPicker hidden={hidden} onChange={setHidden} />
              </div>
            </div>

            <div className="app-scrollbar overflow-x-auto rounded-lg border bg-card">
              <table className="w-full min-w-max border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-xs text-muted-foreground">
                    <th scope="col" className="sticky left-0 z-10 bg-muted px-3 py-2 text-left font-medium sm:px-4">
                      {t("lyricsTranslation.audioFile")}
                    </th>
                    {columns.map(([language, labelKey]) => {
                      const open = selectableTracks(language);
                      const allChosen =
                        open.length > 0 && open.every(({ audioId }) => selection.get(audioId)?.targets.has(language));
                      const name = t(labelKey);
                      return (
                        <th
                          key={language || "fallback"}
                          scope="col"
                          className="w-24 px-1 py-1.5 text-center font-medium"
                        >
                          {language === allLyricsLanguages || open.length === 0 ? (
                            <span className="flex flex-col items-center gap-0.5 px-1 py-1 leading-tight">
                              <span>{name}</span>
                              <ColumnNote language={language} origin={origin} unsupported={!supports(language)} />
                            </span>
                          ) : (
                            <button
                              type="button"
                              aria-pressed={allChosen}
                              aria-label={t("lyricsTranslation.selectColumn", { language: name })}
                              title={t("lyricsTranslation.selectColumn", { language: name })}
                              disabled={working}
                              onClick={() =>
                                setSelection((current) => toggleTranslationColumn(current, open, language, origin))
                              }
                              className={cn(
                                "flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1 leading-tight transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                allChosen && "text-primary",
                              )}
                            >
                              <span>{name}</span>
                              <ColumnNote language={language} origin={origin} unsupported={false} />
                            </button>
                          )}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                {groups.map(([folder, entries]) => (
                  <tbody key={folder} className="border-b last:border-b-0">
                    {groups.length > 1 && (
                      <tr className="bg-muted/20">
                        <th
                          scope="colgroup"
                          colSpan={columns.length + 1}
                          className="px-3 py-1.5 text-left text-xs font-normal text-muted-foreground sm:px-4"
                        >
                          <span className="flex items-center gap-2">
                            <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate">{folder || t("lyricsManager.rootFolder")}</span>
                          </span>
                        </th>
                      </tr>
                    )}
                    {entries.map((entry) => {
                      const track = trackByID.get(entry.mediaItemId)!;
                      const row = selection.get(track.audioId);
                      return (
                        <tr key={track.audioId} className={cn("border-t first:border-t-0", row && "bg-primary/5")}>
                          <th
                            scope="row"
                            className={cn(
                              "sticky left-0 z-10 max-w-[16rem] bg-card px-3 py-1.5 text-left font-normal sm:max-w-xs sm:px-4",
                            )}
                          >
                            <span className="block truncate" title={entry.path}>
                              {entry.title}
                            </span>
                          </th>
                          {columns.map(([language, labelKey]) => {
                            const lyricsID = track.lyrics.get(language);
                            const task = openTasks.get(`${track.audioId}:${language}`);
                            return (
                              <td key={language || "fallback"} className="px-1 py-1">
                                <MatrixCell
                                  track={entry.title}
                                  language={t(labelKey)}
                                  fallback={language === allLyricsLanguages}
                                  has={lyricsID !== undefined}
                                  remoteSource={
                                    lyricsID === undefined || !sourceFiles.get(lyricsID)?.remote
                                      ? null
                                      : sourceFiles.get(lyricsID)!.sourceName
                                  }
                                  source={row?.source === language}
                                  canBeSource={row !== undefined && lyricsID !== undefined}
                                  target={row?.targets.has(language) ?? false}
                                  canBeTarget={selectable(track, language)}
                                  task={task?.state ?? null}
                                  rating={lyricsID === undefined ? undefined : ratingOf(lyricsID, track.audioId)}
                                  disabled={working}
                                  onToggleTarget={() =>
                                    setSelection((current) =>
                                      toggleTranslationTarget(current, track.audioId, track.lyrics, language, origin),
                                    )
                                  }
                                  onChooseSource={() =>
                                    setSelection((current) => chooseTranslationSource(current, track.audioId, language))
                                  }
                                />
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                ))}
              </table>
            </div>
          </>
        )}

        <section aria-labelledby="lyrics-translation-list" className="min-w-0 space-y-2 pt-2">
          <div className="flex items-center justify-between gap-2">
            <h4 id="lyrics-translation-list" className="flex items-center gap-2 text-sm font-medium">
              {t("lyricsTranslation.listTitle")}
              {translations.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-px text-2xs tabular-nums text-muted-foreground">
                  {translations.length}
                </span>
              )}
              {awaitingReview > 0 && (
                <Badge variant="warning" className="px-1.5 py-0 text-2xs">
                  {t("lyricsTranslation.awaitingCount", { count: awaitingReview })}
                </Badge>
              )}
            </h4>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("lyricsTranslation.refresh")}
              title={t("lyricsTranslation.refresh")}
              onClick={() => void load()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          {listState === "loading" ? (
            <LyricsNote icon={<Loader2 className="animate-spin" aria-hidden="true" />}>
              {t("lyricsTranslation.loading")}
            </LyricsNote>
          ) : listState === "failed" ? (
            <p
              role="alert"
              className="rounded-lg border border-error-border bg-error-surface px-3 py-2.5 text-sm text-error-foreground"
            >
              {t("lyricsTranslation.loadFailed")}
            </p>
          ) : translations.length === 0 ? (
            <LyricsNote icon={<Languages aria-hidden="true" />}>{t("lyricsTranslation.empty")}</LyricsNote>
          ) : (
            <ul className="divide-y overflow-hidden rounded-lg border bg-card">
              {translations.map((item) => {
                const busy = busyID === item.taskId;
                const track = audioByID.get(item.audioMediaItemId);
                const title = track?.title ?? t("lyricsTranslation.unknownTrack");
                const source = fileByLocation.get(item.lyricsLocationId);
                return (
                  <li key={item.taskId} className="px-3 py-2.5 sm:px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1 basis-56">
                        <div className="truncate text-sm font-medium">{title}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant={stateBadges[item.state]}>{t(`lyricsTranslation.states.${item.state}`)}</Badge>
                          <span className="truncate">
                            {t("lyricsTranslation.summary", {
                              source: source?.title ?? t("lyricsTranslation.unknownSource"),
                              language: languageName(item.targetLanguage),
                              provider: item.providerName || t("lyricsTranslation.unknownProvider"),
                            })}
                          </span>
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1">
                        {item.state === "ready" && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-expanded={previewID === item.taskId}
                              aria-label={t("lyricsTranslation.previewOf", { title })}
                              onClick={() => setPreviewID((current) => (current === item.taskId ? null : item.taskId))}
                            >
                              <FileText className="h-4 w-4" />
                              {t("lyricsTranslation.preview")}
                            </Button>
                            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(item, "discard")}>
                              <Trash2 className="h-4 w-4" />
                              {t("lyricsTranslation.discard")}
                            </Button>
                          </>
                        )}
                        {reviewStates.has(item.state) && (
                          <Button size="sm" disabled={busy} onClick={() => void act(item, "accept")}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            {t("lyricsTranslation.accept")}
                          </Button>
                        )}
                        {item.state === "uncertain" && (
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(item, "resend")}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
                            {t("lyricsTranslation.resend")}
                          </Button>
                        )}
                      </div>
                    </div>
                    {item.state === "uncertain" && (
                      <p className="mt-1 text-xs text-error-foreground">{t("lyricsTranslation.uncertainHint")}</p>
                    )}
                    {stoppedStates.has(item.state) && (
                      <p className="mt-1 text-xs text-error-foreground">
                        {t(
                          `lyricsTranslation.failures.${knownFailures.has(item.failureCode ?? "") ? item.failureCode : "unknown"}`,
                        )}
                      </p>
                    )}
                    {item.state === "expired" && (
                      <p className="mt-1 text-xs text-muted-foreground">{t("lyricsTranslation.expiredHint")}</p>
                    )}
                    {item.state === "publishing" && (
                      <p className="mt-1 text-xs text-warning-foreground">{t("lyricsTranslation.publishingHint")}</p>
                    )}
                    {previewID === item.taskId && item.previewId && (
                      <LyricsPreview
                        label={title}
                        loadKey={`llm:${item.previewId}`}
                        load={() => api.lyricsTranslationText(work.id, item.previewId!)}
                        durationSeconds={track?.durationSeconds ?? null}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </DialogBody>
      <DialogFooter className="justify-between">
        {jobs.length === 0 ? (
          <span className="mr-auto text-xs text-muted-foreground">{t("lyricsTranslation.selectHint")}</span>
        ) : (
          <div className="mr-auto flex min-w-0 flex-1 flex-wrap items-end gap-2">
            <span className="flex h-[var(--control-height)] flex-col justify-center text-sm" role="status">
              <span className="font-medium">{t("lyricsTranslation.selectedCount", { count: jobs.length })}</span>
              {excluded > 0 && provider && (
                <span className="text-xs text-warning-foreground">
                  {t("lyricsTranslation.excludedCount", { count: excluded, provider: provider.name })}
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1 basis-52 sm:max-w-72">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t("lyricsTranslation.provider")}</div>
              <FloatingSelect
                value={choiceKey}
                options={providerOptions}
                onValueChange={setChoiceKey}
                ariaLabel={t("lyricsTranslation.provider")}
                triggerLabel={
                  providers === null
                    ? t("lyricsTranslation.loading")
                    : noProvider
                      ? t("lyricsTranslation.noProviderShort")
                      : undefined
                }
                disabled={working || !providers?.length}
              />
            </div>
            <Button onClick={() => void start()} disabled={working || !choice}>
              {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
              {working
                ? t("lyricsTranslation.startingCount", { done: submitting.done, total: submitting.total })
                : t("lyricsTranslation.startCount", { count: jobs.length })}
            </Button>
          </div>
        )}
        <Button variant="ghost" onClick={onClose} disabled={closeDisabled || working}>
          {t("content.close")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** One track's lyrics in one language, and the part it plays in the chosen translations. */
function MatrixCell({
  track,
  language,
  fallback,
  has,
  remoteSource,
  source,
  canBeSource,
  target,
  canBeTarget,
  task,
  rating,
  disabled,
  onToggleTarget,
  onChooseSource,
}: {
  track: string;
  language: string;
  fallback: boolean;
  has: boolean;
  /** The remote source the lyrics are read from, when the work has no local copy. */
  remoteSource: string | null;
  source: boolean;
  canBeSource: boolean;
  target: boolean;
  canBeTarget: boolean;
  task: LLMLyricsTranslationState | null;
  rating: Rating | undefined;
  disabled: boolean;
  onToggleTarget: () => void;
  onChooseSource: () => void;
}) {
  const { t } = useTranslation();
  const base =
    "relative mx-auto flex h-8 w-full min-w-[4.5rem] items-center justify-center gap-1 rounded-md border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default";
  if (has) {
    const ratingLabel =
      rating?.status === "done"
        ? t(`contentRating.classes.${rating.assessment.class}`)
        : rating?.status === "failed"
          ? t("contentRating.failed")
          : null;
    const dot =
      rating?.status === "done" ? (
        <span
          className={cn("absolute right-1 top-1 h-1.5 w-1.5 rounded-full", ratingDots[rating.assessment.class])}
          aria-hidden="true"
        />
      ) : rating?.status === "failed" ? (
        <span
          className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full border border-error bg-card"
          aria-hidden="true"
        />
      ) : rating?.status === "checking" ? (
        <Loader2 className="absolute right-0.5 top-0.5 h-2.5 w-2.5 animate-spin opacity-70" aria-hidden="true" />
      ) : null;
    const title = [
      t(
        source
          ? "lyricsTranslation.cellSource"
          : canBeSource
            ? "lyricsTranslation.cellUseSource"
            : "lyricsTranslation.cellHas",
        { track, language },
      ),
      remoteSource !== null ? t("lyricsTranslation.cellRemote", { source: remoteSource }) : "",
      ratingLabel ? `${t("contentRating.title")}: ${ratingLabel}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <button
        type="button"
        aria-pressed={canBeSource ? source : undefined}
        aria-label={title}
        title={title}
        disabled={disabled || !canBeSource || source}
        onClick={onChooseSource}
        className={cn(
          base,
          source
            ? "border-info-border bg-info-surface text-info-foreground ring-2 ring-info/40"
            : "border-success-border bg-success-surface text-success-foreground",
          canBeSource && !source && "hover:ring-2 hover:ring-info/30",
        )}
      >
        {source ? (
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {source && <span>{t("lyricsTranslation.sourceShort")}</span>}
        {remoteSource !== null && <Cloud className="h-3 w-3 opacity-80" aria-hidden="true" />}
        {dot}
      </button>
    );
  }
  if (fallback) {
    return (
      <span
        className={cn(base, "border-dashed text-muted-foreground")}
        title={t("lyricsTranslation.cellNoFallback", { track })}
      >
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t("lyricsTranslation.cellNoFallback", { track })}</span>
      </span>
    );
  }
  if (task) {
    const reviewing = reviewStates.has(task);
    const label = t(`lyricsTranslation.states.${task}`);
    return (
      <span
        className={cn(
          base,
          reviewing
            ? "border-warning-border bg-warning-surface text-warning-foreground"
            : "border-info-border bg-info-surface text-info-foreground",
        )}
        title={`${language} · ${label}`}
      >
        {reviewing ? (
          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        )}
        <span className="sr-only">{`${track} · ${language} · ${label}`}</span>
      </span>
    );
  }
  const label = t("lyricsTranslation.cellTarget", { track, language });
  return (
    <button
      type="button"
      aria-pressed={target}
      aria-label={label}
      title={canBeTarget ? label : t("lyricsTranslation.cellMissing", { track, language })}
      disabled={disabled || !canBeTarget}
      onClick={onToggleTarget}
      className={cn(
        base,
        target
          ? "border-primary bg-primary text-primary-foreground shadow-sm"
          : "border-error-border bg-error-surface text-error-foreground",
        canBeTarget && !target && "hover:ring-2 hover:ring-primary/40",
        !canBeTarget && "opacity-60",
      )}
    >
      {target ? <Plus className="h-3.5 w-3.5" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
      {target && <span>{t("lyricsTranslation.targetShort")}</span>}
    </button>
  );
}

/** What a column's header notes under its language: the original, or that the model cannot translate into it. */
function ColumnNote({ language, origin, unsupported }: { language: string; origin: string; unsupported: boolean }) {
  const { t } = useTranslation();
  if (language === origin && language !== allLyricsLanguages) {
    return <span className="text-2xs font-normal text-info-foreground">{t("lyricsManager.original")}</span>;
  }
  if (unsupported && language !== allLyricsLanguages) {
    return <span className="text-2xs font-normal text-muted-foreground">{t("translationTargets.unsupported")}</span>;
  }
  return null;
}

/** The colors of the matrix. */
function MatrixLegend() {
  const { t } = useTranslation();
  const items = [
    ["border-success-border bg-success-surface", t("lyricsTranslation.legendHas")],
    ["border-error-border bg-error-surface", t("lyricsTranslation.legendMissing")],
    ["border-info-border bg-info-surface", t("lyricsTranslation.legendSource")],
    ["border-primary bg-primary", t("lyricsTranslation.legendTarget")],
  ] as const;
  return (
    <ul
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
      aria-label={t("lyricsTranslation.legend")}
    >
      {items.map(([swatch, label]) => (
        <li key={label} className="flex items-center gap-1.5">
          <span className={cn("h-3 w-3 shrink-0 rounded-sm border", swatch)} aria-hidden="true" />
          {label}
        </li>
      ))}
    </ul>
  );
}

/** Chooses which language columns the matrix shows. */
function LanguageColumnsPicker({
  hidden,
  onChange,
}: {
  hidden: ReadonlySet<string>;
  onChange: (hidden: ReadonlySet<string>) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const shown = lyricsLanguages.length - hidden.size;
  return (
    <div ref={anchorRef}>
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Columns3 className="h-3.5 w-3.5" />
        {t("lyricsTranslation.columns", { shown, total: lyricsLanguages.length })}
      </Button>
      <AnchoredPopover
        open={open}
        anchorRef={anchorRef}
        onOpenChange={setOpen}
        floatingLayer
        ariaLabel={t("lyricsTranslation.columnsLabel")}
        className="w-[min(14rem,calc(100vw-1.5rem))] p-1 text-sm"
      >
        <div role="group" aria-label={t("lyricsTranslation.columnsLabel")}>
          {lyricsLanguages.map(([language, labelKey]) => {
            const visible = !hidden.has(language);
            return (
              <label
                key={language || "fallback"}
                className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-muted"
              >
                <Checkbox
                  checked={visible}
                  // The matrix keeps at least one column.
                  disabled={visible && shown === 1}
                  onCheckedChange={(checked) => {
                    const next = new Set(hidden);
                    if (checked) next.delete(language);
                    else next.add(language);
                    onChange(next);
                  }}
                />
                {t(labelKey)}
              </label>
            );
          })}
        </div>
      </AnchoredPopover>
    </div>
  );
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
