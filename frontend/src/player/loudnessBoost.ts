/**
 * Full loudness normalization routes the player element through a Web Audio
 * gain node, which can raise a quiet track above full element volume and also
 * applies cuts where a page cannot set media volume, as on iPhone and iPad.
 * Once routed, an element stays routed and only sounds while its context
 * runs, so the element is routed only when a listener chose full
 * normalization, a track needs a change, the page is visible, and the context
 * already runs. Safari starts a context only from a user gesture, so the
 * context is created and resumed from one; until it runs, the element keeps
 * playing through its own output. Web Audio silences cross-origin media
 * without CORS, so an element whose source is on another origin, as in a
 * native app shell, is never routed and keeps using element volume.
 */
type ElementAudio = {
  context: AudioContext;
  /** Set once the element is routed through the context. */
  gain: GainNode | null;
  /** Called when the context starts running while the element is not routed yet. */
  onRunning: (() => void) | null;
};

/** A gain change while a track plays approaches its target with this time constant, in seconds. */
const GAIN_RAMP_TIME_CONSTANT = 0.12;

const audios = new WeakMap<HTMLMediaElement, ElementAudio>();

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function mediaSource(element: HTMLMediaElement) {
  return element.currentSrc || element.getAttribute("src") || "";
}

function sameOriginSource(element: HTMLMediaElement) {
  const source = mediaSource(element);
  if (!source) return false;
  try {
    return new URL(source, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function pageHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function elementAudio(element: HTMLMediaElement) {
  const existing = audios.get(element);
  if (existing) return existing;
  const Context = audioContextConstructor();
  if (!Context) return undefined;
  try {
    const audio: ElementAudio = { context: new Context(), gain: null, onRunning: null };
    audios.set(element, audio);
    audio.context.addEventListener("statechange", () => {
      if (audio.context.state !== "running") {
        // A call, Siri, or another app's audio interrupts the context; an
        // interruption that ends while the element still plays resumes it.
        if (audio.gain && !element.paused) resumeLoudnessGain(element);
        return;
      }
      if (!audio.gain) audio.onRunning?.();
    });
    // Playback that resumes after an interruption, from the page or the lock
    // screen, resumes the context too.
    element.addEventListener("playing", () => {
      if (audio.gain) resumeLoudnessGain(element);
    });
    return audio;
  } catch {
    return undefined;
  }
}

function resumeContext(audio: ElementAudio) {
  const state: string = audio.context.state;
  if (state === "running" || state === "closed") return;
  void audio.context.resume().catch(() => {});
}

function setGain(audio: ElementAudio, gain: number, ramp: boolean) {
  if (!audio.gain) return;
  const param = audio.gain.gain;
  const now = audio.context.currentTime;
  param.cancelScheduledValues(now);
  if (ramp && audio.context.state === "running") param.setTargetAtTime(gain, now, GAIN_RAMP_TIME_CONSTANT);
  else param.setValueAtTime(gain, now);
}

/**
 * Prepares Web Audio from a user gesture: creates the element's context when
 * full normalization may need it and resumes a context that is not running.
 * Safari starts or resumes a context only from a gesture, and a routed
 * element is silent until its context runs again.
 */
export function unlockLoudnessGain(element: HTMLMediaElement | null, mayRoute: boolean) {
  if (!element) return;
  let audio = audios.get(element);
  if (!audio) {
    // The source is set only once a track loads; a later gesture creates the
    // context then.
    if (!mayRoute || (mediaSource(element) && !sameOriginSource(element))) return;
    audio = elementAudio(element);
    if (!audio) return;
  }
  resumeContext(audio);
}

export type LoudnessGainOptions = {
  /** Lets a new route be built; an existing route always applies the gain. */
  allowRouting: boolean;
  /** The level the listener hears now, from which a new route starts. */
  currentGain: number;
  /** Moves to the new gain smoothly instead of at once. */
  ramp: boolean;
  /** Called when the context starts running, so routing can be tried again. */
  onRunning: () => void;
};

/**
 * Applies the loudness gain through Web Audio and reports whether the element
 * is routed; when it is not, the caller applies a cut through element volume.
 */
export function routeLoudnessGain(element: HTMLMediaElement | null, gain: number, options: LoudnessGainOptions) {
  if (!element) return false;
  let audio = audios.get(element);
  if (!audio?.gain) {
    if (!options.allowRouting || gain === 1 || !sameOriginSource(element) || pageHidden()) return false;
    audio = elementAudio(element);
    if (!audio) return false;
    audio.onRunning = options.onRunning;
    if (audio.context.state !== "running") {
      // Outside a gesture Safari refuses this; the element keeps its own
      // output until a gesture starts the context.
      resumeContext(audio);
      return false;
    }
    try {
      const gainNode = audio.context.createGain();
      gainNode.gain.value = options.currentGain;
      audio.context.createMediaElementSource(element).connect(gainNode).connect(audio.context.destination);
      audio.gain = gainNode;
    } catch {
      return false;
    }
  }
  setGain(audio, gain, options.ramp && !element.paused);
  if (!element.paused) resumeLoudnessGain(element);
  return true;
}

/**
 * A routed element only sounds while its context runs. Safari leaves the
 * context interrupted after an audio interruption.
 */
export function resumeLoudnessGain(element: HTMLMediaElement | null) {
  const audio = element ? audios.get(element) : undefined;
  if (audio?.gain) resumeContext(audio);
}
