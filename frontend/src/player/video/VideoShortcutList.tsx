import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { VIDEO_SHORTCUT_GUIDE, type VideoShortcut, videoShortcutKeyLabel } from "@/player/video/videoShortcuts";

function useShortcutLabel() {
  const { t } = useTranslation();
  return (shortcut: VideoShortcut) => {
    switch (shortcut.action) {
      case "togglePlay":
        return t("videoPlayback.shortcuts.playPause");
      case "seek":
        return shortcut.seconds < 0
          ? t("videoPlayback.shortcuts.back", { seconds: -shortcut.seconds })
          : t("videoPlayback.shortcuts.forward", { seconds: shortcut.seconds });
      case "fullscreen":
        return t("videoPlayback.fullscreen");
      case "mute":
        return t("videoPlayback.shortcuts.mute");
      case "rate":
        return shortcut.step < 0 ? t("videoPlayback.shortcuts.slower") : t("videoPlayback.shortcuts.faster");
    }
  };
}

function Keys({ labels }: { labels: readonly string[] }) {
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      {labels.map((label) => (
        <kbd
          key={label}
          className="inline-flex h-6 min-w-6 items-center justify-center rounded border bg-muted px-1.5 font-sans text-xs font-medium text-foreground"
        >
          {label}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The video stage's keyboard shortcuts as a list of actions and their keys,
 * followed by any shortcuts the surrounding view adds.
 */
export function VideoShortcutList({ extra = [] }: { extra?: readonly { keys: readonly string[]; label: string }[] }) {
  const label = useShortcutLabel();
  const rows = [
    ...VIDEO_SHORTCUT_GUIDE.map((entry) => ({
      label: label(entry.shortcut),
      keys: entry.keys.map(videoShortcutKeyLabel),
    })),
    ...extra,
  ];
  return (
    <dl className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 text-sm">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd>
            <Keys labels={row.keys} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
