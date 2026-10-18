import { accountApi } from "@/lib/accountApi";
import { libraryApi } from "@/lib/libraryApi";
import { workApi } from "@/lib/workApi";
import { mediaApi } from "@/lib/mediaApi";
import { metadataApi } from "@/lib/metadataApi";
import { creatorApi } from "@/lib/creatorApi";
import { remoteSourceApi } from "@/lib/remoteSourceApi";
import { workflowApi } from "@/lib/workflowApi";
import { settingsApi } from "@/lib/settingsApi";
import { llmApi } from "@/lib/llmApi";
import { asrApi } from "@/lib/asrApi";
import { workFolderEditApi } from "@/lib/workFolderEditApi";
import { lyricsEditApi } from "@/lib/lyricsEditApi";
import { subscriptionApi } from "@/lib/subscriptionApi";
import { customWorkApi } from "@/lib/customWorkApi";

export type { CatalogSyncState } from "@/lib/catalogSyncState";
export { API_BASE, ApiError, apiTransport, assetURL } from "@/lib/apiTransport";
export { mediaDownloadURL } from "@/lib/mediaApi";
export type * from "@/lib/accountApi";
export type * from "@/lib/libraryApi";
export type * from "@/lib/workApi";
export type * from "@/lib/mediaApi";
export type * from "@/lib/metadataApi";
export type * from "@/lib/creatorApi";
export type * from "@/lib/remoteSourceApi";
export type * from "@/lib/workflowApi";
export type * from "@/lib/settingsApi";
export type * from "@/lib/llmApi";
export type * from "@/lib/asrApi";
export type * from "@/lib/workFolderEditApi";
export type * from "@/lib/lyricsEditApi";
export type * from "@/lib/subscriptionApi";
export type * from "@/lib/customWorkApi";

/**
 * Every domain API behind one object. Each domain module owns its requests and
 * response types; this entry composes them for callers.
 */
export const api = {
  ...accountApi,
  ...libraryApi,
  ...workApi,
  ...mediaApi,
  ...metadataApi,
  ...creatorApi,
  ...remoteSourceApi,
  ...workflowApi,
  ...settingsApi,
  ...llmApi,
  ...asrApi,
  ...workFolderEditApi,
  ...lyricsEditApi,
  ...subscriptionApi,
  ...customWorkApi,
};
