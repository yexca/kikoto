import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { PageID } from "@/app/navigation";
import { NotFoundPage } from "@/app/NotFoundPage";
import {
  announceWorkDetailPlay,
  announceWorkDetailUserState,
  announceWorkDetailWorksChanged,
} from "@/app/workDetailEvents";
import { workDetailCodeFromLocation } from "@/app/workDetailNavigation";
import { useAuth } from "@/auth/AuthProvider";
import { toastFromError, useToast } from "@/components/ui/toast";
import { PersistedWorkDetailController, RemoteOnlyWorkDetailController } from "@/features/work-detail/lazyWorkDetail";
import { api, type LibrarySource, type ListeningStatus } from "@/lib/api";
import { NAVIGATION_EVENT, navigateToHistoryReturn } from "@/lib/browserHistory";
import {
  detailRemoteCodeFromLocation,
  detailSourceIntentFromLocation,
  detailTrackedSourceIDFromLocation,
  isRemoteOnlyWorkLocation,
  remoteTargetFromLocation,
} from "@/pages/library/libraryRoutes";
import { useLibraryWorkDetail } from "@/pages/library/useLibraryWorkDetail";
import { WorkLoadFailed } from "@/pages/library/WorkLoadFailed";

type WorkDetailRoute = { code: string | null; path: string; search: string };

function currentWorkDetailRoute(): WorkDetailRoute {
  const { pathname, search } = window.location;
  return { code: workDetailCodeFromLocation(pathname, search), path: pathname, search };
}

/**
 * The work detail page: a persisted work with its not-found and load-failure
 * states, or a work known only to a remote source. It belongs to the page it
 * was opened from, which supplies the location Back falls back to. One
 * instance serves every owner, so only the visible detail loads or follows
 * playback. Renders nothing while the location shows another page.
 */
export function WorkDetailPage({
  active,
  ownerPage,
  fallbackLocation,
}: {
  active: boolean;
  ownerPage: PageID;
  fallbackLocation: string;
}) {
  const auth = useAuth();
  const toast = useToast();
  const { t } = useTranslation();
  const principalID = auth.user?.id ?? null;
  const [route, setRoute] = useState(currentWorkDetailRoute);
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const sourcesLoaded = useRef(false);
  const [sourcesSettled, setSourcesSettled] = useState(false);

  useEffect(() => {
    const syncRoute = () => setRoute(currentWorkDetailRoute());
    window.addEventListener("popstate", syncRoute);
    window.addEventListener(NAVIGATION_EVENT, syncRoute);
    return () => {
      window.removeEventListener("popstate", syncRoute);
      window.removeEventListener(NAVIGATION_EVENT, syncRoute);
    };
  }, []);

  useEffect(() => {
    if (!active || sourcesLoaded.current) return;
    const controller = new AbortController();
    api
      .listLibrarySources(controller.signal)
      .then((items) => {
        sourcesLoaded.current = true;
        setSources(items);
        setSourcesSettled(true);
      })
      .catch(() => {
        // A work still opens without its remote sources; the next visit asks again.
        if (!controller.signal.aborted) setSourcesSettled(true);
      });
    return () => controller.abort();
  }, [active]);

  const code = active ? route.code : null;
  const remoteOnly = code !== null && isRemoteOnlyWorkLocation(route.search);
  const remoteTarget = useMemo(
    () => (remoteOnly ? remoteTargetFromLocation(route.path, route.search, sources) : null),
    [remoteOnly, route.path, route.search, sources],
  );
  const resolveCode = useCallback(
    (resolvedCode: string | null) => setRoute((current) => ({ ...current, code: resolvedCode })),
    [],
  );
  const detail = useLibraryWorkDetail({
    principalID,
    selectedCode: remoteOnly ? null : code,
    onCodeResolved: resolveCode,
  });

  if (code === null) return null;

  const back = () => navigateToHistoryReturn({ fallbackLocation });
  const openLibrary = () => {
    window.history.pushState({}, "", "/");
    window.dispatchEvent(new Event(NAVIGATION_EVENT));
  };
  const worksChanged = async () => announceWorkDetailWorksChanged();
  const updateWorkStatus = async (workID: number, status: ListeningStatus) => {
    try {
      const result = await api.updateWorkUserState(workID, { listeningStatus: status });
      const patch = { listeningStatus: result.listeningStatus, favorite: result.favorite };
      detail.patchWork(workID, patch);
      announceWorkDetailUserState({ ownerPage, workID, ...patch });
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };
  const updateWorkRating = async (workID: number, rating: number | null) => {
    try {
      const result = await api.updateWorkUserState(workID, { userRating: rating });
      detail.patchWork(workID, { userRating: result.userRating });
    } catch (error) {
      toast.notify(toastFromError(error, t("errors.unavailable")));
    }
  };

  if (remoteOnly) {
    if (remoteTarget === null) {
      return sourcesSettled ? <NotFoundPage onBack={back} onOpenLibrary={openLibrary} /> : <WorkDetailLoading />;
    }
    return (
      <Suspense fallback={<WorkDetailLoading />}>
        <RemoteOnlyWorkDetailController
          source={remoteTarget.source}
          sources={sources}
          code={remoteTarget.code}
          preview={remoteTarget.preview ?? null}
          onBack={back}
          onWorksChanged={worksChanged}
        />
      </Suspense>
    );
  }
  if (detail.loadFailure === "not_found") {
    return (
      <NotFoundPage
        title={t("library.workNotFound")}
        message={t("library.workUnavailableInLibrary", { code })}
        onBack={back}
        onOpenLibrary={openLibrary}
      />
    );
  }
  if (detail.loadFailure === "failed" && !detail.work) {
    return <WorkLoadFailed code={code} onBack={back} onRetry={detail.retry} />;
  }
  return (
    <Suspense fallback={<WorkDetailLoading />}>
      <PersistedWorkDetailController
        code={code}
        work={detail.work}
        workPreview={detail.preview}
        mediaLoading={detail.mediaLoading}
        mediaError={detail.mediaError}
        sources={sources}
        initialSourceIntent={detailSourceIntentFromLocation(route.search)}
        initialTrackedSourceID={detailTrackedSourceIDFromLocation(route.search)}
        initialRemoteCode={detailRemoteCodeFromLocation(route.search)}
        principalID={principalID}
        canForgetWork={auth.hasPermission("sources:write")}
        canSyncMetadata={auth.hasPermission("metadata:sync") && !auth.demoMode}
        onBack={back}
        onStatusChange={updateWorkStatus}
        onRatingChange={updateWorkRating}
        onPlay={() => {
          if (detail.work) announceWorkDetailPlay({ ownerPage, workID: detail.work.id });
        }}
        onWorkReload={detail.reload}
        onWorksChanged={worksChanged}
      />
    </Suspense>
  );
}

function WorkDetailLoading() {
  const { t } = useTranslation();
  return (
    <div className="space-y-5" role="status" aria-label={t("app.loadingPage")}>
      <div className="h-9 w-24 animate-pulse rounded-md bg-muted" />
      <div className="flex flex-col gap-5 lg:flex-row">
        <div className="aspect-[4/3] w-full animate-pulse rounded-lg bg-muted lg:w-80" />
        <div className="flex-1 space-y-3">
          <div className="h-4 w-28 animate-pulse rounded bg-muted" />
          <div className="h-8 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="min-h-[22rem] animate-pulse rounded-lg bg-muted" />
    </div>
  );
}
