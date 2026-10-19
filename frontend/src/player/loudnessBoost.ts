/**
 * Full loudness normalization routes the player element through a Web Audio
 * gain node, which can raise a quiet track above full element volume and also
 * applies cuts where a page cannot set media volume, as on iPhone and iPad.
 * Once routed, an element stays routed, so the graph is only built when a
 * listener chose full normalization and a track needs a change. Web Audio
 * silences cross-origin media without CORS, so an element whose source is on
 * another origin, as in a native app shell, is never routed and keeps using
 * element volume.
 */
type GainGraph = { context: AudioContext; gain: GainNode };

const graphs = new WeakMap<HTMLMediaElement, GainGraph>();

function audioContextConstructor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function sameOriginSource(element: HTMLMediaElement) {
  const source = element.currentSrc || element.getAttribute("src") || "";
  if (!source) return false;
  try {
    return new URL(source, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Applies the loudness gain through Web Audio and reports whether the element
 * is routed; when it is not, the caller applies a cut through element volume.
 * `allowRouting` lets a new graph be built; an existing graph always applies.
 */
export function routeLoudnessGain(element: HTMLMediaElement | null, gain: number, allowRouting: boolean) {
  if (!element) return false;
  let graph = graphs.get(element);
  if (!graph) {
    if (!allowRouting || gain === 1 || !sameOriginSource(element)) return false;
    const Context = audioContextConstructor();
    if (!Context) return false;
    try {
      const context = new Context();
      const gainNode = context.createGain();
      context.createMediaElementSource(element).connect(gainNode).connect(context.destination);
      graph = { context, gain: gainNode };
      graphs.set(element, graph);
    } catch {
      return false;
    }
  }
  graph.gain.gain.value = gain;
  // A routed element is silent while its context is suspended, and a context
  // starts suspended; the graph can be built while a track already plays.
  if (!element.paused) resumeLoudnessGain(element);
  return true;
}

/** A routed element only sounds while its context runs; browsers start it suspended. */
export function resumeLoudnessGain(element: HTMLMediaElement | null) {
  const graph = element ? graphs.get(element) : undefined;
  if (graph && graph.context.state === "suspended") void graph.context.resume().catch(() => {});
}
