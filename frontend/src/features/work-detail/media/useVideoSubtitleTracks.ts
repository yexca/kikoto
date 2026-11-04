import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, assetURL, type VideoEmbeddedSubtitle } from "@/lib/api";
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

/** A `<track>` element to render; `src` is a WebVTT object URL once the track has loaded. */
export type RenderedSubtitleTrack = { key: string; label: string; language?: string; src?: string };

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
  const [sidecarsSettled, setSidecarsSettled] = useState(false);
  const requestedRef = useRef(new Set<string>());
  const initialAppliedRef = useRef(false);
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
      void api
        .getVideoSubtitle(track.url, signal)
        .then((text) => store(track.key, videoSubtitleWebVtt(text)))
        .catch(() => {
          // Selecting the track again retries, such as after a busy server frees a slot.
          requestedRef.current.delete(track.key);
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

  // An embedded track loads when the viewer selects it in the video controls.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const loadSelected = () => {
      for (const element of Array.from(video.querySelectorAll<HTMLTrackElement>(trackSelector))) {
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
    if (element) element.track.mode = "showing";
  }, [rendered, sidecarsSettled, streams, tracks, videoRef]);

  return rendered;
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
