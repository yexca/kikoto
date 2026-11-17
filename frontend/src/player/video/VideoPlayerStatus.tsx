import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

import { formatVideoDuration } from "./videoControlsModel";

/**
 * What a full-screen player shows over its stage: a failure with Retry, which
 * covers the stage; the spinner while the source is prepared; and the question
 * whether to continue from a saved position.
 */
export function VideoPlayerStatus({
  error,
  loading,
  resumePosition,
  onRetry,
  onResume,
  onStartOver,
}: {
  error: string | null;
  loading: boolean;
  /** A saved position to offer, or null when the player does not ask. */
  resumePosition: number | null;
  onRetry: () => void;
  onResume: () => void;
  onStartOver: () => void;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div
        role="alert"
        className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center"
      >
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={onRetry}>
          {t("videoPlayback.retry")}
        </Button>
      </div>
    );
  }
  const prompt =
    resumePosition === null ? null : t("videoPlayback.resumePrompt", { time: formatVideoDuration(resumePosition) });
  return (
    <>
      {loading && (
        <Loader2
          className="absolute h-8 w-8 animate-spin text-muted-foreground"
          role="status"
          aria-label={t("videoPlayback.preparing")}
        />
      )}
      {prompt && (
        <div className="absolute inset-x-0 bottom-6 flex justify-center px-4">
          <div
            role="group"
            aria-label={prompt}
            className="flex flex-wrap items-center justify-center gap-3 rounded-lg border bg-background/90 px-4 py-3 shadow-xl backdrop-blur"
          >
            <span className="text-sm font-medium">{prompt}</span>
            <div className="flex gap-2">
              <Button autoFocus onClick={onResume}>
                {t("videoPlayback.resume")}
              </Button>
              <Button variant="outline" onClick={onStartOver}>
                {t("videoPlayback.startOver")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
