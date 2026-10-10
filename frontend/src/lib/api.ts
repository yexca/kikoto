import { accountApi } from "@/lib/accountApi";
import { libraryApi } from "@/lib/libraryApi";
import { workApi } from "@/lib/workApi";
import { mediaApi } from "@/lib/mediaApi";
import { metadataApi } from "@/lib/metadataApi";
import { creatorApi } from "@/lib/creatorApi";
import { remoteSourceApi } from "@/lib/remoteSourceApi";
import { workflowApi } from "@/lib/workflowApi";
import { settingsApi } from "@/lib/settingsApi";

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
};
