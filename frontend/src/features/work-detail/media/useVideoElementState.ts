import { type RefObject, useEffect, useState } from "react";

import { bufferedFractions, shownVideoSubtitle } from "@/features/work-detail/media/videoControlsModel";

export type VideoElementState = {
  paused: boolean;
  currentTime: number;
  /** The element's duration, NaN until it knows one. */
  duration: number;
  /** Buffered ranges as fractions of the duration. */
  buffered: { start: number; end: number }[];
  rate: number;
  muted: boolean;
  /** Playback waits for data. */
  waiting: boolean;
  /** The element has metadata for its current source. */
  ready: boolean;
  /** The key of the subtitle track that shows, or null. */
  subtitleKey: string | null;
  pictureInPicture: boolean;
  /** An AirPlay receiver is available; only WebKit reports this. */
  airPlayAvailable: boolean;
};

type AirPlayAvailabilityEvent = Event & { availability?: string };

const mediaEvents = [
  "play",
  "pause",
  "ended",
  "timeupdate",
  "durationchange",
  "progress",
  "ratechange",
  "volumechange",
  "waiting",
  "playing",
  "canplay",
  "seeking",
  "seeked",
  "loadstart",
  "loadedmetadata",
  "emptied",
  "enterpictureinpicture",
  "leavepictureinpicture",
] as const;

const trackSelector = "track[data-subtitle-key]";

function readState(video: HTMLVideoElement, waiting: boolean, airPlayAvailable: boolean): VideoElementState {
  return {
    paused: video.paused,
    currentTime: video.currentTime,
    duration: video.duration,
    buffered: bufferedFractions(video.buffered, video.duration),
    rate: video.playbackRate,
    muted: video.muted,
    waiting,
    ready: video.readyState > 0,
    subtitleKey: shownVideoSubtitle(video.querySelectorAll<HTMLTrackElement>(trackSelector)),
    pictureInPicture: typeof document !== "undefined" && document.pictureInPictureElement === video,
    airPlayAvailable,
  };
}

/** What the on-screen controls show, read from the video element's own events. */
export function useVideoElementState(videoRef: RefObject<HTMLVideoElement | null>) {
  const [state, setState] = useState<VideoElementState>(() => ({
    paused: true,
    currentTime: 0,
    duration: Number.NaN,
    buffered: [],
    rate: 1,
    muted: false,
    waiting: false,
    ready: false,
    subtitleKey: null,
    pictureInPicture: false,
    airPlayAvailable: false,
  }));

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let waiting = false;
    let airPlayAvailable = false;
    const update = (event?: Event) => {
      switch (event?.type) {
        case "waiting":
          waiting = true;
          break;
        case "playing":
        case "canplay":
        case "pause":
        case "seeked":
        case "emptied":
          waiting = false;
          break;
      }
      setState(readState(video, waiting, airPlayAvailable));
    };
    const updateAirPlay = (event: Event) => {
      airPlayAvailable = (event as AirPlayAvailabilityEvent).availability === "available";
      update();
    };
    for (const name of mediaEvents) video.addEventListener(name, update);
    video.textTracks.addEventListener("change", update);
    video.textTracks.addEventListener("addtrack", update);
    video.textTracks.addEventListener("removetrack", update);
    video.addEventListener("webkitplaybacktargetavailabilitychanged", updateAirPlay);
    update();
    return () => {
      for (const name of mediaEvents) video.removeEventListener(name, update);
      video.textTracks.removeEventListener("change", update);
      video.textTracks.removeEventListener("addtrack", update);
      video.textTracks.removeEventListener("removetrack", update);
      video.removeEventListener("webkitplaybacktargetavailabilitychanged", updateAirPlay);
    };
  }, [videoRef]);

  return state;
}
