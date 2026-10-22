import { describe, expect, it, vi } from "vitest";

import { attachAudioHls } from "./audioHlsSource";

const attachedMedia = vi.hoisted(() => [] as unknown[]);

vi.mock("hls.js", () => {
  class FakeHls {
    static Events = { MANIFEST_PARSED: "manifestParsed", ERROR: "error" };
    static ErrorTypes = { MEDIA_ERROR: "mediaError" };
    on() {}
    loadSource() {}
    attachMedia(media: unknown) {
      attachedMedia.push(media);
    }
    destroy() {}
  }
  return { default: FakeHls };
});

function fakeAudio(previousSource: string) {
  const audio = {
    src: previousSource,
    readyState: 4,
    removeAttribute: vi.fn((name: string) => {
      if (name === "src") audio.src = "";
    }),
    load: vi.fn(() => {
      if (!audio.src) audio.readyState = 0;
    }),
  };
  return audio;
}

describe("attachAudioHls", () => {
  it("empties the element before hls.js attaches", async () => {
    const audio = fakeAudio("/api/media/locations/1/stream");
    const onAttached = vi.fn();

    const detach = attachAudioHls(
      audio as unknown as HTMLAudioElement,
      "/api/media/locations/2/hls/index.m3u8",
      "mse",
      {
        startPosition: () => 754,
        onAttached,
        onFatalError: vi.fn(),
      },
    );

    // The previous track is gone before hls.js loads, so a start position
    // waits for the new track's metadata instead of seeking the old one.
    expect(audio.src).toBe("");
    expect(audio.readyState).toBe(0);
    expect(onAttached).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(onAttached).toHaveBeenCalledOnce());
    expect(attachedMedia).toContain(audio);
    detach();
  });
});
