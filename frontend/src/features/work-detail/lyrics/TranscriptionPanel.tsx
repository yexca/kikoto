import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines, Check, FileText, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { LyricsManagerAudio } from "@/features/work-detail/lyrics/lyricsManagerModel";
import {
  ContentRatingCheck,
  ServiceChoiceLabel,
  useContentRating,
} from "@/features/work-detail/lyrics/ContentRatingCheck";
import { serviceReceives } from "@/features/work-detail/lyrics/contentRatingModel";
import { LyricsNote } from "@/features/work-detail/lyrics/LyricsNote";
import { LyricsPreview } from "@/features/work-detail/lyrics/LyricsPreview";
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

const activeStates: ReadonlySet<ASRTranscriptionState> = new Set(["pending", "requesting"]);
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
  "asr_audio_too_long",
  "asr_ffmpeg_unavailable",
]);

/**
 * Starts speech transcriptions of local tracks and reviews their results. A
 * finished transcription waits here until someone adds it to the lyrics or
 * discards it.
 */
export function TranscriptionPanel({
  work,
  audio,
  onPublished,
}: {
  work: WorkDetail;
  audio: LyricsManagerAudio[];
  /** Reloads the work after a transcription became a lyrics file. */
  onPublished: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [services, setServices] = useState<ASRService[] | null>(null);
  const [transcriptions, setTranscriptions] = useState<ASRTranscription[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const [audioID, setAudioID] = useState(() => audio[0]?.mediaItemId ?? 0);
  // A service and one of its enabled models, as a serviceModelKey.
  const [choiceKey, setChoiceKey] = useState("");
  const [language, setLanguage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyID, setBusyID] = useState<string | null>(null);
  const [previewID, setPreviewID] = useState<string | null>(null);
  const audioByID = useMemo(() => new Map(audio.map((entry) => [entry.mediaItemId, entry])), [audio]);

  const load = useCallback(async () => {
    try {
      const result = await api.listASRTranscriptions(work.id);
      setTranscriptions(result.transcriptions);
      // The work's original language is the first suggestion; nothing is chosen for the user after that.
      setLanguage((current) => current ?? result.originLanguage);
      setListState("ready");
    } catch (error) {
      setListState((current) => (current === "ready" ? current : "failed"));
      toast.notify(toastFromError(error, t("asrTranscription.loadFailed")));
    }
  }, [t, toast, work.id]);

  useEffect(() => {
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
  }, [load, t, toast]);

  const active = transcriptions.some((item) => activeStates.has(item.state));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const choices = serviceModelChoices(services ?? []);
  const choice = choices.find((candidate) => candidate.key === choiceKey) ?? null;
  const rating = useContentRating(String(audioID), async () => {
    try {
      return await api.precheckASRTranscription(work.id, audioID);
    } catch (error) {
      toast.notify(
        error instanceof ApiError && startRefusals.has(error.code)
          ? { kind: "error", message: t(`asrTranscription.errors.${error.code}`) }
          : toastFromError(error, t("contentRating.failed")),
      );
      throw error;
    }
  });

  const start = async () => {
    if (!audioID || !choice || language === null) return;
    setSubmitting(true);
    try {
      const queued = await api.createASRTranscription(work.id, {
        audioMediaItemId: audioID,
        providerId: choice.service.id,
        model: choice.model,
        language,
      });
      toast.notify({
        kind: queued.deduplicated ? "info" : "success",
        message: t(queued.deduplicated ? "asrTranscription.joined" : "asrTranscription.queued"),
        actionLabel: t("notifications.openActivity"),
        onAction: () => openActivityRun(queued.runId),
      });
      await load();
    } catch (error) {
      toast.notify(
        error instanceof ApiError && startRefusals.has(error.code)
          ? { kind: "error", message: t(`asrTranscription.errors.${error.code}`) }
          : toastFromError(error, t("asrTranscription.startFailed")),
      );
    } finally {
      setSubmitting(false);
    }
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

  const languageLabel = (value: string) =>
    value === allLyricsLanguages
      ? t("asrTranscription.detect")
      : t(lyricsLanguages.find(([token]) => token === value)?.[1] ?? "asrTranscription.detect");
  const trackOptions: FloatingSelectOption[] = audio.map((entry) => ({
    value: String(entry.mediaItemId),
    label: (
      <span className="flex min-w-0 flex-col" title={entry.path}>
        <span className="truncate">{entry.title}</span>
        {entry.folder && <span className="truncate text-xs text-muted-foreground">{entry.folder}</span>}
      </span>
    ),
  }));
  const serviceOptions: FloatingSelectOption[] = choices.map(({ key, service, model }) => ({
    value: key,
    label: (
      <ServiceChoiceLabel
        name={`${service.name} · ${model}`}
        excluded={rating.contentClass !== null && !serviceReceives(rating.contentClass, service)}
      />
    ),
  }));
  const service = choice?.service ?? null;
  const languageOptions: FloatingSelectOption[] = [
    { value: allLyricsLanguages, label: t("asrTranscription.detect") },
    ...lyricsLanguages
      .filter(([value]) => value !== allLyricsLanguages)
      .map(([value, labelKey]) => ({ value, label: t(labelKey) })),
  ];
  const noService = services !== null && services.length === 0;

  return (
    <div className="grid gap-5 @3xl:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] @3xl:items-start">
      <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
        <p className="text-sm text-muted-foreground">{t("asrTranscription.intro")}</p>
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t("asrTranscription.track")}</div>
          <FloatingSelect
            value={String(audioID)}
            options={trackOptions}
            onValueChange={(value) => setAudioID(Number(value))}
            ariaLabel={t("asrTranscription.track")}
            disabled={submitting}
            contentClassName="max-w-[min(32rem,calc(100vw-1.5rem))]"
          />
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t("asrTranscription.service")}</div>
          <FloatingSelect
            value={choiceKey}
            options={serviceOptions}
            onValueChange={setChoiceKey}
            ariaLabel={t("asrTranscription.service")}
            triggerLabel={
              services === null
                ? t("asrTranscription.loading")
                : noService
                  ? t("asrTranscription.noServiceShort")
                  : undefined
            }
            disabled={submitting || !services?.length}
          />
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t("asrTranscription.language")}</div>
          <FloatingSelect
            value={language ?? allLyricsLanguages}
            options={languageOptions}
            onValueChange={setLanguage}
            ariaLabel={t("asrTranscription.language")}
            disabled={submitting || language === null}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {noService ? t("asrTranscription.noService") : t("asrTranscription.languageHint")}
        </p>
        <p className="text-xs text-muted-foreground">{t("contentRating.metadataOnly")}</p>
        <ContentRatingCheck rating={rating} service={service} disabled={submitting || !audioID} />
        <Button
          className="w-full"
          onClick={() => void start()}
          disabled={submitting || !audioID || !choice || language === null}
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <AudioLines className="h-4 w-4" />}
          {submitting ? t("asrTranscription.starting") : t("asrTranscription.start")}
        </Button>
      </div>

      <section aria-labelledby="asr-transcription-list" className="min-w-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 id="asr-transcription-list" className="flex items-center gap-2 text-sm font-medium">
            {t("asrTranscription.listTitle")}
            {transcriptions.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-px text-2xs tabular-nums text-muted-foreground">
                {transcriptions.length}
              </span>
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
                            language: languageLabel(item.language),
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
                          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(item, "discard")}>
                            <Trash2 className="h-4 w-4" />
                            {t("asrTranscription.discard")}
                          </Button>
                        )}
                        <Button size="sm" disabled={busy} onClick={() => void act(item, "accept")}>
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
                      load={() => api.asrTranscriptionText(item.id)}
                      durationSeconds={audioByID.get(item.audioMediaItemId)?.durationSeconds ?? null}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
