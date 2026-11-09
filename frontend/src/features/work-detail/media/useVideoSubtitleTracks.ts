import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, assetURL, type VideoEmbeddedSubtitle } from "@/lib/api";
import { keepOneVideoSubtitle } from "@/features/work-detail/media/videoControlsModel";
import {
  initialVideoSubtitleKey,
  sidecarSubtitleKey,
  subtitleLanguageName,
  type VideoSubtitle,
  type VideoSubtitleTrack,
  videoSubtitleTracks,
  videoSubtitleWebVtt,
} from "@/features/work-detail/media/videoSubtitles";

const MAX_SUBTITLE_BYTES = 512 * 1024;
const trackSelector = "track[data-subtitle-key]";

/**
 * A `<track>` element to render; `src` is a WebVTT object URL once the track
 * has loaded. An embedded track reports whether it is loading or its last
 * load failed.
 */
export type RenderedSubtitleTrack = {
  key: string;
  label: string;
  language?: string;
  src?: string;
  status?: "loading" | "failed";
};

/**
 * The subtitle tracks of a video element. Sidecar files load at once, and a
 * file that fails is left out. An embedded stream loads only once it is
 * selected, because the server extracts it by reading the whole video file.
 * Once playback info and the sidecar files have settled, the preferred track
 * shows.
 */
export function useVideoSubtitleTracks(
  videoRef: RefObject<HTMLVideoElement | null>,
  sidecars: VideoSubtitle[],
  /** The embedded text streams playback info lists, or null until it arrives. */
  embedded: VideoEmbeddedSubtitle[] | null,
) {
  const { t, i18n } = useTranslation();
  // A refetch of playback info, such as a fallback to a transcode, keeps the
  // embedded tracks and the viewer's selection.
  const [knownEmbedded, setKnownEmbedded] = useState(embedded);
  if (embedded && embedded !== knownEmbedded) setKnownEmbedded(embedded);
  const streams = embedded ?? knownEmbedded;
  const tracks = useMemo(
    () =>
      videoSubtitleTracks(sidecars, streams ?? [], {
        languageName: (tag) => subtitleLanguageName(tag, i18n.language),
        untitled: (number) => t("videoPlayback.subtitleTrack", { number }),
        forced: (label) => t("videoPlayback.forcedSubtitle", { label }),
      }),
    [streams, i18n.language, sidecars, t],
  );
  const [sources, setSources] = useState<Record<string, string | null>>({});
  const [statuses, setStatuses] = useState<Record<string, "loading" | "failed">>({});
  const [sidecarsSettled, setSidecarsSettled] = useState(false);
  const requestedRef = useRef(new Set<string>());
  const initialAppliedRef = useRef(false);
  /** The track that shows, kept when the browser shows another beside it. */
  const shownKeyRef = useRef<string | null>(null);
  const lifetimeRef = useRef<{ controller: AbortController; urls: string[] } | null>(null);

  useEffect(() => {
    const lifetime = { controller: new AbortController(), urls: [] as string[] };
    lifetimeRef.current = lifetime;
    return () => {
      lifetime.controller.abort();
      for (const url of lifetime.urls) URL.revokeObjectURL(url);
      lifetimeRef.current = null;
    };
  }, []);

  const store = useCallback((key: string, content: string | null) => {
    const lifetime = lifetimeRef.current;
    if (!lifetime || lifetime.controller.signal.aborted) return;
    const src = content ? URL.createObjectURL(new Blob([content], { type: "text/vtt" })) : null;
    if (src) lifetime.urls.push(src);
    setSources((current) => ({ ...current, [key]: src }));
  }, []);

  useEffect(() => {
    if (sidecars.length === 0) {
      setSidecarsSettled(true);
      return;
    }
    const controller = new AbortController();
    void Promise.allSettled(sidecars.map((subtitle) => loadSidecarText(subtitle, controller.signal))).then(
      (results) => {
        if (controller.signal.aborted) return;
        results.forEach((result, index) =>
          store(
            sidecarSubtitleKey(sidecars[index]),
            result.status === "fulfilled" ? videoSubtitleWebVtt(result.value) : null,
          ),
        );
        setSidecarsSettled(true);
      },
    );
    return () => controller.abort();
  }, [sidecars, store]);

  const requestEmbedded = useCallback(
    (track: VideoSubtitleTrack) => {
      const signal = lifetimeRef.current?.controller.signal;
      if (!signal || track.kind !== "embedded" || requestedRef.current.has(track.key)) return;
      requestedRef.current.add(track.key);
      const settle = (status: "failed" | null) =>
        setStatuses((current) => {
          const next = { ...current };
          if (status) next[track.key] = status;
          else delete next[track.key];
          return next;
        });
      setStatuses((current) => ({ ...current, [track.key]: "loading" }));
      void api
        .getVideoSubtitle(track.url, signal)
        .then((text) => {
          store(track.key, videoSubtitleWebVtt(text));
          if (!signal.aborted) settle(null);
        })
        .catch(() => {
          if (signal.aborted) return;
          // Selecting the track again retries, such as after a busy server frees a slot.
          requestedRef.current.delete(track.key);
          settle("failed");
        });
    },
    [store],
  );

  // Rendered tracks leave out sidecar files that failed or are still loading.
  const rendered = useMemo<RenderedSubtitleTrack[]>(
    () =>
      tracks.flatMap((track) => {
        const src = sources[track.key] ?? undefined;
        if (track.kind === "sidecar" && !src) return [];
        return [{ key: track.key, label: track.label, language: track.language, src }];
      }),
    [sources, tracks],
  );
  // Kept apart from `rendered`, so a failed load does not select and request the track again by itself.
  const withStatus = useMemo(
    () => rendered.map((track) => (statuses[track.key] ? { ...track, status: statuses[track.key] } : track)),
    [rendered, statuses],
  );

  // An embedded track loads when the viewer selects it in the video controls.
  // A track the browser shows by itself beside the shown one is switched off
  // first, so it neither shows nor loads.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const loadSelected = () => {
      const elements = Array.from(video.querySelectorAll<HTMLTrackElement>(trackSelector));
      shownKeyRef.current = keepOneVideoSubtitle(elements, shownKeyRef.current);
      for (const element of elements) {
        if (element.track.mode === "disabled") continue;
        const track = tracks.find((candidate) => candidate.key === element.dataset.subtitleKey);
        if (track) requestEmbedded(track);
      }
    };
    video.textTracks.addEventListener("change", loadSelected);
    loadSelected();
    return () => video.textTracks.removeEventListener("change", loadSelected);
  }, [rendered, requestEmbedded, tracks, videoRef]);

  // The preferred track shows once, after playback info and the sidecar files have settled.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streams || !sidecarsSettled || initialAppliedRef.current || rendered.length === 0) return;
    initialAppliedRef.current = true;
    if (Array.from(video.textTracks).some((track) => track.mode === "showing")) return;
    const key = initialVideoSubtitleKey(
      tracks.filter((track) => rendered.some((candidate) => candidate.key === track.key)),
      streams,
    );
    const element = Array.from(video.querySelectorAll<HTMLTrackElement>(trackSelector)).find(
      (candidate) => candidate.dataset.subtitleKey === key,
    );
    if (!element) return;
    shownKeyRef.current = key ?? null;
    element.track.mode = "showing";
  }, [rendered, sidecarsSettled, streams, tracks, videoRef]);

  return withStatus;
}

async function loadSidecarText(subtitle: VideoSubtitle, signal: AbortSignal) {
  if (!subtitle.url) return (await api.getMediaText(subtitle.locationId)).content;
  const response = await fetch(assetURL(subtitle.url), { headers: { Accept: "text/plain,text/*" }, signal });
  if (!response.ok) throw new Error(`Subtitle request returned HTTP ${response.status}.`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_SUBTITLE_BYTES) throw new Error("Subtitle too large.");
  const content = await response.text();
  if (content.length > MAX_SUBTITLE_BYTES) throw new Error("Subtitle too large.");
  return content;
}
