import { preloadableComponent } from "@/lib/preloadableComponent";

// Work detail loads as its own chunk. The app shell starts it beside the Library
// chunk for a direct work link, an idle Library preloads it, and a detail
// location starts it with the page, so opening or restoring a work normally
// renders without suspending. Every caller shares this one dynamic import.
const loadWorkDetail = () => import("@/features/work-detail/WorkDetail");
const remoteOnlyWorkDetail = preloadableComponent(() =>
  loadWorkDetail().then((module) => module.RemoteOnlyWorkDetailController),
);
const persistedWorkDetail = preloadableComponent(() =>
  loadWorkDetail().then((module) => module.PersistedWorkDetailController),
);

export const RemoteOnlyWorkDetailController = remoteOnlyWorkDetail.Component;
export const PersistedWorkDetailController = persistedWorkDetail.Component;

export function preloadWorkDetail() {
  void remoteOnlyWorkDetail.preload().catch(() => {});
  void persistedWorkDetail.preload().catch(() => {});
}
