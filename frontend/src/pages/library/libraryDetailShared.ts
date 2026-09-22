// Work previews, routes, and link helpers shared by the Library list and its work detail.

import { ApiError, type ListeningStatus, type RemoteWork, type SourcePresenceItem, type Work } from "@/lib/api";
import { DLSITE_ENDPOINTS } from "@/lib/official-links";
import type { DetailSourceIntent } from "@/features/work-detail/source/sourceContextModel";
import { openWorkDetail } from "@/app/workDetailNavigation";
import i18n from "@/i18n";

export type WorkPreview = Pick<
  Work,
  | "primaryCode"
  | "title"
  | "coverUrl"
  | "circle"
  | "circleExternalId"
  | "rating"
  | "sales"
  | "releaseDate"
  | "tags"
  | "voiceActors"
> & {
  id?: number;
};

export type RemoteWorkPreview = WorkPreview &
  Pick<RemoteWork, "remoteCode" | "ageRating"> & {
    remoteId?: string;
  };

export const listeningStatusOptions: { value: ListeningStatus; label: string }[] = [
  { value: "none", label: "Unmarked" },
  { value: "want_to_listen", label: "Want" },
  { value: "listening", label: "Listening" },
  { value: "finished", label: "Finished" },
  { value: "relisten", label: "Relisten" },
  { value: "paused", label: "Shelved" },
];

export function dlsiteWorkURL(code: string) {
  const site = code.toUpperCase().startsWith("RJ") ? "maniax" : "home";
  return DLSITE_ENDPOINTS.workURL(site, code);
}

export function openWorkCodeRoute(code: string, sourceIntent?: DetailSourceIntent, trackedSourceID?: number | null) {
  const cleanCode = code.trim();
  if (!cleanCode) return;
  openWorkDetail(
    {
      kind: "known",
      canonicalCode: cleanCode,
      view: sourceIntent === "tracked" ? "tracked" : sourceIntent === "local" ? "local" : undefined,
      trackedSourceId: sourceIntent === "tracked" ? trackedSourceID : undefined,
    },
    {
      returnTo: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      returnLabel: i18n.t("detailActions.back"),
    },
  );
}

export function directoryLoadErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.code === "database_busy") {
    return "The database is busy. The work details remain available; retry the directory shortly.";
  }
  return error instanceof Error && error.message ? error.message : i18n.t("libraryDetail.remoteDirectoryFailed");
}

export function safeExternalHTTPURL(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function sourcePresenceActionCode(presence: SourcePresenceItem, fallbackCode: string) {
  return presence.remoteCode || fallbackCode;
}
