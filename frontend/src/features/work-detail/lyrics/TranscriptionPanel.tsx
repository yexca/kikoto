import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines, Check, FileText, Folder, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DemoLyricsTaskNotice } from "@/components/DemoReadOnlyNotice";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogBody, DialogFooter } from "@/components/ui/dialog";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { segmentedItemClassName, segmentedListClassName } from "@/components/ui/segmented";
import { toastFromError, useToast } from "@/components/ui/toast";
import { groupAudioByFolder, type LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import {
  ContentRatingButton,
  ContentRatingResult,
  ServiceChoiceLabel,
  useContentRating,
} from "@/features/work-detail/lyrics/ContentRatingCheck";
import { serviceReceives } from "@/features/work-detail/lyrics/contentRatingModel";
import { demoASRServices, demoLyricsText, demoTranscriptions } from "@/features/work-detail/lyrics/demoLyricsTaskModel";
import { LyricsNote } from "@/features/work-detail/lyrics/LyricsNote";
import { LyricsPreview } from "@/features/work-detail/lyrics/LyricsPreview";
import {
  matchesTranscribeFilter,
  modelCapability,
  offersTranscription,
  trackLyricsByLanguage,
  transcriptionOutput,
  workOriginLyricsLanguage,
  type TranscribeFilter,
} from "@/features/work-detail/lyrics/lyricsTaskModel";
import { formatTrackDuration } from "@/features/work-detail/media/mediaTreeModel";
import {
  ApiError,
  api,
  type ASRService,
  type ASRTranscription,
  type ASRTranscriptionState,
  type WorkDetail,
} from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";
import { serviceModelChoices } from "@/lib/serviceModels";
import { cn } from "@/lib/tailwindClassNames";

const activeStates: ReadonlySet<ASRTranscriptionState> = new Set(["pending", "requesting"]);
/** States a track's row reports: work in progress or waiting for someone. */
const openStates: ReadonlySet<ASRTranscriptionState> = new Set([
  "pending",
  "requesting",
  "ready",
  "publishing",
  "failed",
]);
const pollMs = 4000;

const stateBadges: Record<ASRTranscriptionState, BadgeProps["variant"]> = {
  pending: "secondary",
  requesting: "info",
  failed: "error",
  ready: "warning",
  publishing: "warning",
  accepted: "success",
  rejected: "secondary",
  cancelled: "secondary",
};

const knownFailures = new Set([
  "upstream_result_unknown",
  "upstream_rejected",
  "upstream_failed",
  "service_not_ready",
  "service_start_failed",
  "service_out_of_memory",
  "unsupported_language_pair",
  "output_language_mismatch",
  "no_timestamps",
  "no_speech",
  "provider_changed",
  "policy_blocked",
  "permission_changed",
  "source_changed",
  "source_unavailable",
  "audio_decode_failed",
  "audio_too_long",
  "transcript_too_large",
  "ffmpeg_unavailable",
  "endpoint_unavailable",
  "cancelled",
]);

/** Refusals that say what to change, rather than that starting failed. */
const startRefusals = new Set([
  "asr_policy_blocked",
  "asr_audio_unavailable",
  "asr_not_ready",
  "asr_language_unsupported",
  "asr_audio_too_long",
  "asr_ffmpeg_unavailable",
]);

/**
 * Lists the work's local tracks with the lyrics they have, starts speech
 * transcriptions of the selected ones, and reviews the results. A finished
 * transcription waits here until someone adds it to the lyrics or discards it.
 * Demo shows sample transcriptions and services and leaves every action off.
 */
export function TranscriptionPanel({
  work,
  audio,
  demo = false,
  closeDisabled,
  onClose,
  onPublished,
}: {
  work: WorkDetail;
  audio: LyricsManagerAudio[];
  /** Shows samples instead of contacting the server's speech recognition. */
  demo?: boolean;
  closeDisabled: boolean;
  onClose: () => void;
  /** Reloads the work after a transcription became a lyrics file. */
  onPublished: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [services, setServices] = useState<ASRService[] | null>(demo ? demoASRServices : null);
  const [loadedTranscriptions, setTranscriptions] = useState<ASRTranscription[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">(demo ? "ready" : "loading");
  const [serverOrigin, setServerOrigin] = useState<string | null>(null);
  const [filter, setFilter] = useState<TranscribeFilter>("noLyrics");
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  // The spoken language the user chose; until then, the work's original language.
  const [chosenAudio, setChosenAudio] = useState<string | null>(null);
  // A service and one of its enabled models, as a serviceModelKey.
  const [choiceKey, setChoiceKey] = useState(() => (demo ? serviceModelChoices(demoASRServices)[0]?.key : "") ?? "");
  // The lyrics language chosen for a model of unknown capability, kept only
  // for the model and audio language it was chosen with.
  const [chosenOutput, setChosenOutput] = useState<{ key: string; language: string } | null>(null);
  const [submitting, setSubmitting] = useState<{ done: number; total: number } | null>(null);
  const [busyID, setBusyID] = useState<string | null>(null);
  const [previewID, setPreviewID] = useState<string | null>(null);
  const audioByID = useMemo(() => new Map(audio.map((entry) => [entry.mediaItemId, entry])), [audio]);
  const lyricsByTrack = useMemo(
    () => new Map(audio.map((entry) => [entry.mediaItemId, trackLyricsByLanguage(entry)])),
    [audio],
  );
  const origin = serverOrigin ?? workOriginLyricsLanguage(work);
  const transcriptions = useMemo(
    () => (demo ? demoTranscriptions(audio, origin) : loadedTranscriptions),
    [audio, demo, loadedTranscriptions, origin],
  );

  const load = useCallback(async () => {
    if (demo) return;
    try {
      const result = await api.listASRTranscriptions(work.id);
      setTranscriptions(result.transcriptions);
      setServerOrigin(result.originLanguage);
      setListState("ready");
    } catch (error) {
      setListState((current) => (current === "ready" ? current : "failed"));
      toast.notify(toastFromError(error, t("asrTranscription.loadFailed")));
    }
  }, [demo, t, toast, work.id]);

  useEffect(() => {
    if (demo) return;
    void load();
    api
      .listASRServices()
      .then((result) => {
        setServices(result);
        setChoiceKey((current) => current || serviceModelChoices(result)[0]?.key || "");
      })
      .catch((error) => {
        setServices([]);
        toast.notify(toastFromError(error, t("asrTranscription.servicesFailed")));
      });
  }, [demo, load, t, toast]);

  const active = transcriptions.some((item) => activeStates.has(item.state));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [active, load]);

  // Audio is rated from the work's metadata, so one check covers every track.
  const ratingTrack = audio[0]?.mediaItemId ?? 0;
  const rating = useContentRating("work", async () => {
    try {
      return await api.precheckASRTranscription(work.id, ratingTrack);
    } catch (error) {
      toast.notify(
        error instanceof ApiError && startRefusals.has(error.code)
          ? { kind: "error", message: t(`asrTranscription.errors.${error.code}`) }
          : toastFromError(error, t("contentRating.failed")),
      );
      throw error;
    }
  });

  const filters: TranscribeFilter[] =
    origin === allLyricsLanguages ? ["noLyrics", "all"] : ["noLyrics", "noOrigin", "all"];
  const filterCount = (value: TranscribeFilter) =>
    audio.filter((entry) => matchesTranscribeFilter(lyricsByTrack.get(entry.mediaItemId)!, value, origin)).length;
  const visible = audio.filter((entry) =>
    matchesTranscribeFilter(lyricsByTrack.get(entry.mediaItemId)!, filter, origin),
  );
  const selection = visible.filter((entry) => selected.has(entry.mediaItemId));
  const allSelected = visible.length > 0 && selection.length === visible.length;
  // The newest transcription of each track that still needs attention.
  const openByTrack = new Map<number, ASRTranscription>();
  for (const item of transcriptions) {
    if (!openByTrack.has(item.audioMediaItemId) && openStates.has(item.state)) {
      openByTrack.set(item.audioMediaItemId, item);
    }
  }
  const awaitingReview = transcriptions.filter((item) => item.state === "ready").length;

  const toggle = (audioId: number, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(audioId);
      else next.delete(audioId);
      return next;
    });

  const chooseFilter = (value: TranscribeFilter) => {
    setFilter(value);
    setSelected(new Set());
  };

  // The audio language comes first; it decides which models are offered, and
  // the model decides the lyrics language.
  const language = chosenAudio ?? origin;
  const choices = serviceModelChoices(services ?? []).filter((candidate) =>
    offersTranscription(modelCapability(candidate.service, candidate.model), language),
  );
  const choice = choices.find((candidate) => candidate.key === choiceKey) ?? choices[0] ?? null;
  const service = choice?.service ?? null;
  const noService = services !== null && services.length === 0;
  const noModel = !noService && services !== null && choices.length === 0;
  const capability = choice ? modelCapability(choice.service, choice.model) : null;
  const outputKey = `${choice?.key ?? ""}\n${language}`;
  const output = capability
    ? transcriptionOutput(capability, language, chosenOutput?.key === outputKey ? chosenOutput.language : null)
    : { language, fixed: true };
  const lyricsLanguage = output.language;

  const start = async () => {
    if (selection.length === 0 || !choice) return;
    let queued = 0;
    let joined = 0;
    let lastRun = 0;
    setSubmitting({ done: 0, total: selection.length });
    try {
      for (const [index, entry] of selection.entries()) {
        const result = await api.createASRTranscription(work.id, {
          audioMediaItemId: entry.mediaItemId,
          providerId: choice.service.id,
          model: choice.model,
          language: lyricsLanguage,
          audioLanguage: language,
        });
        if (result.deduplicated) joined++;
        else queued++;
        lastRun = result.runId;
        setSubmitting({ done: index + 1, total: selection.length });
      }
      setSelected(new Set());
    } catch (error) {
      toast.notify(
        error instanceof ApiError && startRefusals.has(error.code)
          ? { kind: "error", message: t(`asrTranscription.errors.${error.code}`) }
          : toastFromError(error, t("asrTranscription.startFailed")),
      );
    } finally {
      setSubmitting(null);
    }
    if (queued + joined > 0) {
      toast.notify({
        kind: queued > 0 ? "success" : "info",
        message:
          queued > 0
            ? t("asrTranscription.queuedCount", { count: queued }) +
              (joined > 0 ? ` ${t("asrTranscription.joinedCount", { count: joined })}` : "")
            : t("asrTranscription.joinedCount", { count: joined }),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openActivityRun(lastRun),
      });
    }
    await load();
  };

  const act = async (item: ASRTranscription, action: "accept" | "discard") => {
    setBusyID(item.id);
    try {
      if (action === "accept") {
        await api.acceptASRTranscription(item.id);
        toast.success(t("asrTranscription.accepted"));
        await onPublished();
      } else {
        await api.discardASRTranscription(item.id);
        toast.success(t("asrTranscription.discarded"));
      }
      setPreviewID(null);
    } catch (error) {
      toast.notify(
        toastFromError(
          error,
          t(action === "accept" ? "asrTranscription.acceptFailed" : "asrTranscription.discardFailed"),
        ),
      );
    } finally {
      setBusyID(null);
      await load();
    }
  };

  const languageName = (value: string) =>
    value === allLyricsLanguages
      ? t("asrTranscription.detect")
      : t(lyricsLanguages.find(([token]) => token === value)?.[1] ?? "asrTranscription.detect");
  const originName = t(lyricsLanguages.find(([token]) => token === origin)?.[1] ?? "lyricsManager.fallback");
  // A translating model names the direction it writes.
  const serviceOptions: FloatingSelectOption[] = choices.map(({ key, service, model }) => {
    const translation = modelCapability(service, model).translation;
    const direction = translation
      ? ` (${t("asrTranscription.languageDirection", { audio: languageName(translation.source), lyrics: languageName(translation.target) })})`
      : "";
    return {
      value: key,
      label: (
        <ServiceChoiceLabel
          name={`${service.name} · ${model}${direction}`}
          excluded={rating.contentClass !== null && !serviceReceives(rating.contentClass, service)}
        />
      ),
    };
  });
  const languageOptions: FloatingSelectOption[] = [
    { value: allLyricsLanguages, label: t("asrTranscription.detect") },
    ...lyricsLanguages
      .filter(([value]) => value !== allLyricsLanguages)
      .map(([value, labelKey]) => ({
        value,
        label:
          value === origin ? (
            <span className="flex min-w-0 items-center justify-between gap-3">
              <span className="truncate">{t(labelKey)}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t("lyricsManager.original")}</span>
            </span>
          ) : (
            t(labelKey)
          ),
      })),
  ];
  const lyricsLanguageOptions = languageOptions.filter(({ value }) => value !== allLyricsLanguages);
  const groups = groupAudioByFolder(visible);
  const working = submitting !== null;

  return (
    <>
      <DialogBody className="space-y-4">
        {demo && <DemoLyricsTaskNotice task="transcription" />}
        <p className="text-sm text-muted-foreground">{t("asrTranscription.intro")}</p>
        {noService && (
          <p className="rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-sm text-warning-foreground">
            {t("asrTranscription.noService")}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="tablist" aria-label={t("asrTranscription.filter")} className={segmentedListClassName()}>
            {filters.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                className={segmentedItemClassName(filter === value, "gap-1.5")}
                onClick={() => chooseFilter(value)}
              >
                {t(`asrTranscription.filters.${value}`, { language: originName })}
                <span className="rounded-full bg-background/70 px-1.5 text-2xs tabular-nums text-muted-foreground">
                  {filterCount(value)}
                </span>
              </button>
            ))}
          </div>
          <ContentRatingButton
            checking={rating.status === "checking"}
            checked={rating.status === "done"}
            disabled={demo || !ratingTrack}
            onCheck={rating.run}
          />
        </div>
        <ContentRatingResult rating={rating} service={service} />

        {visible.length === 0 ? (
          <LyricsNote icon={<Check aria-hidden="true" />}>
            {t(`asrTranscription.filterEmpty.${filter}`, { language: originName })}
          </LyricsNote>
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground sm:px-4">
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && selection.length > 0}
                aria-label={t("asrTranscription.selectAll")}
                disabled={working}
                onCheckedChange={(checked) =>
                  setSelected(checked ? new Set(visible.map((entry) => entry.mediaItemId)) : new Set())
                }
              />
              <span className="min-w-0 flex-1">{t("asrTranscription.audioFile")}</span>
              <span className="hidden sm:block">{t("lyricsManager.lyrics")}</span>
            </div>
            {groups.map(([folder, entries]) => (
              <section key={folder} aria-label={folder || t("lyricsManager.rootFolder")}>
                {groups.length > 1 && (
                  <h4 className="flex items-center gap-2 border-b bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground sm:px-4">
                    <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{folder || t("lyricsManager.rootFolder")}</span>
                  </h4>
                )}
                <ul className="divide-y border-b last:border-b-0">
                  {entries.map((entry) => {
                    const checked = selected.has(entry.mediaItemId);
                    const open = openByTrack.get(entry.mediaItemId);
                    const lyrics = lyricsByTrack.get(entry.mediaItemId)!;
                    return (
                      <li key={entry.mediaItemId}>
                        <label
                          className={cn(
                            "flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40 sm:px-4",
                            checked && "bg-primary/5",
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={working}
                            aria-label={t("asrTranscription.selectTrack", { title: entry.title })}
                            onCheckedChange={(next) => toggle(entry.mediaItemId, next)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm" title={entry.path}>
                              {entry.title}
                            </span>
                            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                              {entry.durationSeconds !== null && (
                                <span className="tabular-nums">{formatTrackDuration(entry.durationSeconds)}</span>
                              )}
                              {open && (
                                <Badge variant={stateBadges[open.state]} className="px-1.5 py-0 text-2xs">
                                  {t(`asrTranscription.states.${open.state}`)}
                                </Badge>
                              )}
                            </span>
                          </span>
                          <LyricsLanguageChips lyrics={lyrics} origin={origin} />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        <section aria-labelledby="asr-transcription-list" className="min-w-0 space-y-2 pt-2">
          <div className="flex items-center justify-between gap-2">
            <h4 id="asr-transcription-list" className="flex items-center gap-2 text-sm font-medium">
              {t("asrTranscription.listTitle")}
              {transcriptions.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 py-px text-2xs tabular-nums text-muted-foreground">
                  {transcriptions.length}
                </span>
              )}
              {awaitingReview > 0 && (
                <Badge variant="warning" className="px-1.5 py-0 text-2xs">
                  {t("asrTranscription.awaitingCount", { count: awaitingReview })}
                </Badge>
              )}
            </h4>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("asrTranscription.refresh")}
              title={t("asrTranscription.refresh")}
              onClick={() => void load()}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          {listState === "loading" ? (
            <LyricsNote icon={<Loader2 className="animate-spin" aria-hidden="true" />}>
              {t("asrTranscription.loading")}
            </LyricsNote>
          ) : listState === "failed" ? (
            <p
              role="alert"
              className="rounded-lg border border-error-border bg-error-surface px-3 py-2.5 text-sm text-error-foreground"
            >
              {t("asrTranscription.loadFailed")}
            </p>
          ) : transcriptions.length === 0 ? (
            <LyricsNote icon={<AudioLines aria-hidden="true" />}>{t("asrTranscription.empty")}</LyricsNote>
          ) : (
            <ul className="divide-y overflow-hidden rounded-lg border bg-card">
              {transcriptions.map((item) => {
                const reviewable = item.state === "ready" || item.state === "publishing";
                const busy = busyID === item.id;
                // The lyrics manager names a track by its file; a track no longer listed keeps the stored title.
                const title = audioByID.get(item.audioMediaItemId)?.title ?? item.audioTitle;
                const progress =
                  activeStates.has(item.state) && item.durationMs > 0
                    ? Math.min(100, Math.floor((item.progressMs / item.durationMs) * 100))
                    : null;
                return (
                  <li key={item.id} className="px-3 py-2.5 sm:px-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="min-w-0 flex-1 basis-56">
                        <div className="truncate text-sm font-medium">{title}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant={stateBadges[item.state]}>{t(`asrTranscription.states.${item.state}`)}</Badge>
                          <span className="truncate">
                            {t("asrTranscription.summary", {
                              service: item.providerName,
                              model: item.model,
                              language:
                                item.audioLanguage === item.language
                                  ? languageName(item.language)
                                  : t("asrTranscription.languageDirection", {
                                      audio: languageName(item.audioLanguage),
                                      lyrics: languageName(item.language),
                                    }),
                            })}
                          </span>
                          {progress !== null && <span className="tabular-nums">{progress}%</span>}
                        </div>
                        {progress !== null && (
                          <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                            <div
                              className="h-full rounded-full bg-info transition-[width] duration-500"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        )}
                      </div>
                      {reviewable && (
                        <div className="flex shrink-0 flex-wrap items-center gap-1">
                          {item.state === "ready" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-expanded={previewID === item.id}
                              aria-label={t("asrTranscription.previewOf", { title })}
                              onClick={() => setPreviewID((current) => (current === item.id ? null : item.id))}
                            >
                              <FileText className="h-4 w-4" />
                              {t("asrTranscription.preview")}
                            </Button>
                          )}
                          {item.state === "ready" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={demo || busy}
                              onClick={() => void act(item, "discard")}
                            >
                              <Trash2 className="h-4 w-4" />
                              {t("asrTranscription.discard")}
                            </Button>
                          )}
                          <Button size="sm" disabled={demo || busy} onClick={() => void act(item, "accept")}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                            {t("asrTranscription.accept")}
                          </Button>
                        </div>
                      )}
                    </div>
                    {item.state === "failed" && (
                      <p className="mt-1 text-xs text-error-foreground">
                        {t(
                          `asrTranscription.failures.${knownFailures.has(item.failureCode ?? "") ? item.failureCode : "unknown"}`,
                        )}{" "}
                        {t("asrTranscription.retryHint")}
                      </p>
                    )}
                    {item.state === "publishing" && (
                      <p className="mt-1 text-xs text-warning-foreground">{t("asrTranscription.publishingHint")}</p>
                    )}
                    {previewID === item.id && (
                      <LyricsPreview
                        label={title}
                        loadKey={`asr:${item.id}`}
                        load={() =>
                          demo
                            ? Promise.resolve(
                                demoLyricsText(
                                  audioByID.get(item.audioMediaItemId)?.durationSeconds ?? null,
                                  (number) => t("asrTranscription.demoCue", { number }),
                                ),
                              )
                            : api.asrTranscriptionText(item.id)
                        }
                        durationSeconds={audioByID.get(item.audioMediaItemId)?.durationSeconds ?? null}
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
        {selection.length === 0 ? (
          <span className="mr-auto text-xs text-muted-foreground">{t("asrTranscription.selectHint")}</span>
        ) : (
          <div className="mr-auto flex min-w-0 flex-1 flex-wrap items-end gap-2">
            <span className="flex h-[var(--control-height)] items-center text-sm font-medium" role="status">
              {t("asrTranscription.selectedCount", { count: selection.length })}
            </span>
            <div className="min-w-0 basis-48">
              <div
                className="mb-1 text-xs font-medium text-muted-foreground"
                title={t("asrTranscription.languageHint")}
              >
                {t("asrTranscription.language")}
              </div>
              <FloatingSelect
                value={language}
                options={languageOptions}
                onValueChange={setChosenAudio}
                ariaLabel={t("asrTranscription.language")}
                disabled={working}
              />
            </div>
            <div className="min-w-0 flex-1 basis-56 sm:max-w-80">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t("asrTranscription.model")}</div>
              <FloatingSelect
                value={choice?.key ?? ""}
                options={serviceOptions}
                onValueChange={setChoiceKey}
                ariaLabel={t("asrTranscription.model")}
                triggerLabel={
                  services === null
                    ? t("asrTranscription.loading")
                    : noService
                      ? t("asrTranscription.noServiceShort")
                      : noModel
                        ? t("asrTranscription.noModelShort")
                        : undefined
                }
                disabled={working || choices.length === 0}
              />
            </div>
            <div className="min-w-0 basis-48">
              <div
                className="mb-1 text-xs font-medium text-muted-foreground"
                title={t("asrTranscription.lyricsLanguageHint")}
              >
                {t("asrTranscription.lyricsLanguage")}
              </div>
              <FloatingSelect
                value={lyricsLanguage}
                options={output.fixed ? languageOptions : lyricsLanguageOptions}
                onValueChange={(value) => setChosenOutput({ key: outputKey, language: value })}
                ariaLabel={t("asrTranscription.lyricsLanguage")}
                triggerLabel={lyricsLanguage === allLyricsLanguages ? t("lyricsManager.fallback") : undefined}
                disabled={working || output.fixed}
              />
            </div>
            <Button onClick={() => void start()} disabled={demo || working || !choice}>
              {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <AudioLines className="h-4 w-4" />}
              {working
                ? t("asrTranscription.startingCount", { done: submitting.done, total: submitting.total })
                : t("asrTranscription.startCount", { count: selection.length })}
            </Button>
            {noModel ? (
              <p role="status" className="basis-full text-xs text-warning-foreground">
                {t("asrTranscription.noModel", { language: languageName(language) })}
              </p>
            ) : (
              capability?.kind === "unknown" &&
              language !== allLyricsLanguages && (
                <p role="status" className="basis-full text-xs text-muted-foreground">
                  {t("asrTranscription.unknownModel")}
                </p>
              )
            )}
          </div>
        )}
        <Button variant="ghost" onClick={onClose} disabled={closeDisabled || working}>
          {t("content.close")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The languages a track has lyrics in, the original language first; or that it has none. */
function LyricsLanguageChips({ lyrics, origin }: { lyrics: ReadonlyMap<string, number>; origin: string }) {
  const { t } = useTranslation();
  if (lyrics.size === 0) {
    return <span className="shrink-0 text-xs text-error-foreground">{t("asrTranscription.noLyrics")}</span>;
  }
  const languages = lyricsLanguages.filter(([language]) => lyrics.has(language));
  languages.sort(([left], [right]) => Number(right === origin) - Number(left === origin));
  return (
    <span className="flex max-w-[45%] shrink-0 flex-wrap justify-end gap-1">
      {languages.map(([language, labelKey]) => (
        <span
          key={language || "fallback"}
          className="rounded border border-success-border bg-success-surface px-1.5 text-2xs leading-5 text-success-foreground"
        >
          {t(labelKey)}
        </span>
      ))}
    </span>
  );
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
