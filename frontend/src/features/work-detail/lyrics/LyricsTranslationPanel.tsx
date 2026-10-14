import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, FileText, Languages, Loader2, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FloatingSelect, type FloatingSelectOption } from "@/components/ui/floating-select";
import { toastFromError, useToast } from "@/components/ui/toast";
import type { LyricsManagerAudio, LyricsManagerFile } from "@/features/work-detail/lyrics/lyricsManagerModel";
import { LyricsPreview } from "@/features/work-detail/lyrics/LyricsPreview";
import {
  ApiError,
  api,
  type LLMLyricsTranslation,
  type LLMLyricsTranslationState,
  type LLMTranslationModel,
  type WorkDetail,
} from "@/lib/api";
import { NAVIGATION_EVENT } from "@/lib/browserHistory";
import { allLyricsLanguages, lyricsLanguages } from "@/lib/lyricsLanguage";
import { isLyricsPath } from "@/player/lyricsMatching";

const activeStates: ReadonlySet<LLMLyricsTranslationState> = new Set(["pending", "requesting"]);
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
]);

/** Refusals that say what to change, rather than that starting failed. */
const startRefusals = new Set([
  "llm_policy_blocked",
  "llm_not_ready",
  "llm_lyrics_scope",
  "llm_lyrics_format",
  "llm_input_too_large",
  "llm_remote_lyrics_disabled",
]);

/** The lyrics language of each interface language, the first target suggested. */
const interfaceLyricsLanguages: Record<string, string> = {
  ja: "ja-jp",
  en: "en-us",
  "zh-Hans": "zh-cn",
  "zh-Hant": "zh-tw",
  ko: "ko-kr",
};

/** A lyrics file that can be translated: a local file, or a remote one where an administrator allows it. */
type LyricsSource = { locationId: number; mediaItemId: number; title: string; detail: string };

/**
 * Translates a lyrics file of the work with an LLM provider and reviews the
 * results. A translation keeps the file's timing and joins the target
 * language's lyrics of the chosen track, which it is assigned to.
 */
export function LyricsTranslationPanel({
  work,
  audio,
  lyrics,
  onPublished,
}: {
  work: WorkDetail;
  audio: LyricsManagerAudio[];
  lyrics: LyricsManagerFile[];
  /** Reloads the work after a translation became a lyrics file. */
  onPublished: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const sources = useMemo(() => lyricsSources(work, lyrics), [lyrics, work]);
  const [providers, setProviders] = useState<LLMTranslationModel[] | null>(null);
  const [translations, setTranslations] = useState<LLMLyricsTranslation[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const [locationID, setLocationID] = useState(() => sources[0]?.locationId ?? 0);
  const [audioID, setAudioID] = useState(() => trackForLyrics(audio, sources[0]?.mediaItemId) ?? 0);
  const [providerID, setProviderID] = useState("");
  const [language, setLanguage] = useState(
    () => interfaceLyricsLanguages[i18n.resolvedLanguage ?? ""] ?? interfaceLyricsLanguages.en,
  );
  const [submitting, setSubmitting] = useState(false);
  const [busyID, setBusyID] = useState<number | null>(null);
  const [previewID, setPreviewID] = useState<number | null>(null);
  const audioByID = useMemo(() => new Map(audio.map((entry) => [entry.mediaItemId, entry])), [audio]);
  const sourceByLocation = useMemo(() => new Map(sources.map((source) => [source.locationId, source])), [sources]);

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
      .listTranslationModels()
      .then((result) => {
        setProviders(result);
        setProviderID((current) => current || result[0]?.id || "");
      })
      .catch((error) => {
        setProviders([]);
        toast.notify(toastFromError(error, t("lyricsTranslation.providersFailed")));
      });
  }, [load, t, toast]);

  const active = translations.some((item) => activeStates.has(item.state));
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const selectSource = (value: string) => {
    const source = sourceByLocation.get(Number(value));
    setLocationID(Number(value));
    // The track the file already belongs to is the likely destination; any
    // other file needs its track chosen.
    setAudioID(trackForLyrics(audio, source?.mediaItemId) ?? 0);
  };

  const start = async () => {
    if (!locationID || !audioID || !providerID || !language) return;
    setSubmitting(true);
    try {
      const { runs } = await api.queueTranslations([work.primaryCode], {
        providerId: providerID,
        targetLanguage: language,
        fields: ["lyrics"],
        lyricsLocationId: locationID,
        audioMediaItemId: audioID,
      });
      const run = runs[0];
      toast.notify({
        kind: run?.deduplicated ? "info" : "success",
        message: t(run?.deduplicated ? "lyricsTranslation.joined" : "lyricsTranslation.queued"),
        ...(run ? { actionLabel: t("notifications.openActivity"), onAction: () => openActivityRun(run.runId) } : {}),
      });
      await load();
    } catch (error) {
      toast.notify(
        error instanceof ApiError && startRefusals.has(error.code)
          ? { kind: "error", message: t(`lyricsTranslation.errors.${error.code}`) }
          : toastFromError(error, t("lyricsTranslation.startFailed")),
      );
    } finally {
      setSubmitting(false);
    }
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

  const languageLabel = (value: string) =>
    t(lyricsLanguages.find(([token]) => token === value)?.[1] ?? "lyricsTranslation.unknownLanguage");
  const sourceOptions: FloatingSelectOption[] = sources.map((source) => ({
    value: String(source.locationId),
    label: (
      <span className="flex min-w-0 flex-col" title={source.detail}>
        <span className="truncate">{source.title}</span>
        {source.detail && <span className="truncate text-xs text-muted-foreground">{source.detail}</span>}
      </span>
    ),
  }));
  const trackOptions: FloatingSelectOption[] = audio.map((entry) => ({
    value: String(entry.mediaItemId),
    label: (
      <span className="flex min-w-0 flex-col" title={entry.path}>
        <span className="truncate">{entry.title}</span>
        {entry.folder && <span className="truncate text-xs text-muted-foreground">{entry.folder}</span>}
      </span>
    ),
  }));
  const providerOptions: FloatingSelectOption[] = (providers ?? []).map((provider) => ({
    value: provider.id,
    label: `${provider.name} · ${provider.defaultModel}`,
  }));
  const languageOptions: FloatingSelectOption[] = lyricsLanguages
    .filter(([value]) => value !== allLyricsLanguages)
    .map(([value, labelKey]) => ({ value, label: t(labelKey) }));
  const noProvider = providers !== null && providers.length === 0;
  const ready = Boolean(locationID && audioID && providerID && language);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">{t("lyricsTranslation.intro")}</p>
      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("lyricsTranslation.noLyrics")}</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t("lyricsTranslation.source")}</div>
            <FloatingSelect
              value={String(locationID)}
              options={sourceOptions}
              onValueChange={selectSource}
              ariaLabel={t("lyricsTranslation.source")}
              disabled={submitting}
              contentClassName="max-w-[min(32rem,calc(100vw-1.5rem))]"
            />
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t("lyricsTranslation.track")}</div>
            <FloatingSelect
              value={String(audioID)}
              options={trackOptions}
              onValueChange={(value) => setAudioID(Number(value))}
              ariaLabel={t("lyricsTranslation.track")}
              triggerLabel={audioID ? undefined : t("lyricsTranslation.chooseTrack")}
              disabled={submitting}
              contentClassName="max-w-[min(32rem,calc(100vw-1.5rem))]"
            />
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t("lyricsTranslation.provider")}</div>
            <FloatingSelect
              value={providerID}
              options={providerOptions}
              onValueChange={setProviderID}
              ariaLabel={t("lyricsTranslation.provider")}
              triggerLabel={
                providers === null
                  ? t("lyricsTranslation.loading")
                  : noProvider
                    ? t("lyricsTranslation.noProviderShort")
                    : undefined
              }
              disabled={submitting || !providers?.length}
            />
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t("lyricsTranslation.language")}</div>
            <FloatingSelect
              value={language}
              options={languageOptions}
              onValueChange={setLanguage}
              ariaLabel={t("lyricsTranslation.language")}
              disabled={submitting}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {noProvider ? t("lyricsTranslation.noProvider") : t("lyricsTranslation.hint")}
          </p>
          <div className="sm:col-span-2">
            <Button onClick={() => void start()} disabled={submitting || !ready}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
              {submitting ? t("lyricsTranslation.starting") : t("lyricsTranslation.start")}
            </Button>
          </div>
        </div>
      )}

      <section aria-labelledby="lyrics-translation-list" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 id="lyrics-translation-list" className="text-sm font-medium">
            {t("lyricsTranslation.listTitle")}
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
          <p className="text-sm text-muted-foreground">{t("lyricsTranslation.loading")}</p>
        ) : listState === "failed" ? (
          <p role="alert" className="text-sm text-error-foreground">
            {t("lyricsTranslation.loadFailed")}
          </p>
        ) : translations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("lyricsTranslation.empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {translations.map((item) => {
              const busy = busyID === item.taskId;
              const track = audioByID.get(item.audioMediaItemId);
              const title = track?.title ?? t("lyricsTranslation.unknownTrack");
              const source = sourceByLocation.get(item.lyricsLocationId);
              return (
                <li key={item.taskId} className="px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1 basis-56">
                      <div className="truncate text-sm font-medium">{title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        <Badge variant={stateBadges[item.state]}>{t(`lyricsTranslation.states.${item.state}`)}</Badge>
                        <span className="truncate">
                          {t("lyricsTranslation.summary", {
                            source: source?.title ?? t("lyricsTranslation.unknownSource"),
                            language: languageLabel(item.targetLanguage),
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
                      {(item.state === "ready" || item.state === "publishing") && (
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
    </div>
  );
}

/** The work's local lyrics files, then remote lyrics files the server may read when allowed. */
function lyricsSources(work: WorkDetail, lyrics: LyricsManagerFile[]): LyricsSource[] {
  const local = lyrics.map((file) => ({
    locationId: file.locationId,
    mediaItemId: file.mediaItemId,
    title: file.title,
    detail: file.folder,
  }));
  const remote = work.mediaItems.flatMap((item) =>
    item.kind === "audio" || item.kind === "video"
      ? []
      : item.locations
          .filter((location) => location.locationType === "remote_stream" && isLyricsPath(location.path))
          .map((location) => ({
            locationId: location.id,
            mediaItemId: item.id,
            title: item.title,
            detail: location.fileSourceName,
          })),
  );
  return [...local, ...remote];
}

/** The track a lyrics file is assigned to in any language, or matched to by name. */
function trackForLyrics(audio: LyricsManagerAudio[], lyricsMediaItemId: number | undefined): number | null {
  if (lyricsMediaItemId === undefined) return audio[0]?.mediaItemId ?? null;
  const assigned = audio.find((entry) => Object.values(entry.assignedLyrics).includes(lyricsMediaItemId));
  const matched = audio.find((entry) => entry.autoLyricsMediaItemId === lyricsMediaItemId);
  return (assigned ?? matched)?.mediaItemId ?? null;
}

function openActivityRun(runId: number) {
  window.history.pushState({}, "", `/workflows?activity=1&run=${runId}`);
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}
