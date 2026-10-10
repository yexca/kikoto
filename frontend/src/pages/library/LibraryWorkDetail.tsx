import { Suspense } from "react";
import { useTranslation } from "react-i18next";

import { NotFoundPage } from "@/app/NotFoundPage";
import { useAuth } from "@/auth/AuthProvider";
import { PersistedWorkDetailController, RemoteOnlyWorkDetailController } from "@/features/work-detail/lazyWorkDetail";
import type { RemoteWorkPreview } from "@/features/work-detail/workDetailShared";
import type { LibrarySource, ListeningStatus } from "@/lib/api";
import type { ClientPrincipalID } from "@/lib/clientStorageScope";

import {
  detailRemoteCodeFromLocation,
  detailSourceIntentFromLocation,
  detailTrackedSourceIDFromLocation,
} from "./libraryRoutes";
import type { LibraryWorkDetailState } from "./useLibraryWorkDetail";
import { WorkLoadFailed } from "./WorkLoadFailed";

export type LibraryRemoteTarget = { source: LibrarySource; code: string; preview?: RemoteWorkPreview };

/**
 * The detail surface of the Library route: a work known only to a remote
 * source, or a persisted work with its not-found and load-failure states.
 * Renders nothing while the route shows the list.
 */
export function LibraryWorkDetail({
  remoteTarget,
  code,
  detail,
  sources,
  principalID,
  onBack,
  onOpenLibrary,
  onStatusChange,
  onPlay,
  onWorksChanged,
}: {
  remoteTarget: LibraryRemoteTarget | null;
  code: string | null;
  detail: LibraryWorkDetailState;
  sources: LibrarySource[];
  principalID: ClientPrincipalID;
  onBack: () => void;
  onOpenLibrary: () => void;
  onStatusChange: (workID: number, status: ListeningStatus) => Promise<void>;
  onPlay: () => void;
  onWorksChanged: () => Promise<void>;
}) {
  const auth = useAuth();
  const { t } = useTranslation();
  if (remoteTarget !== null) {
    return (
      <Suspense fallback={<WorkDetailLoading />}>
        <RemoteOnlyWorkDetailController
          source={remoteTarget.source}
          sources={sources}
          code={remoteTarget.code}
          preview={remoteTarget.preview ?? null}
          onBack={onBack}
          onWorksChanged={async () => await onWorksChanged()}
        />
      </Suspense>
    );
  }
  if (code === null) return null;
  if (detail.loadFailure === "not_found") {
    return (
      <NotFoundPage
        title={t("library.workNotFound")}
        message={t("library.workUnavailableInLibrary", { code })}
        onBack={onBack}
        onOpenLibrary={onOpenLibrary}
      />
    );
  }
  if (detail.loadFailure === "failed" && !detail.work) {
    return <WorkLoadFailed code={code} onBack={onBack} onRetry={detail.retry} />;
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
        initialSourceIntent={detailSourceIntentFromLocation(window.location.search)}
        initialTrackedSourceID={detailTrackedSourceIDFromLocation(window.location.search)}
        initialRemoteCode={detailRemoteCodeFromLocation(window.location.search)}
        principalID={principalID}
        canForgetWork={auth.hasPermission("sources:write")}
        canSyncMetadata={auth.hasPermission("metadata:sync") && !auth.demoMode}
        onBack={onBack}
        onStatusChange={onStatusChange}
        onPlay={onPlay}
        onWorkReload={detail.reload}
        onWorksChanged={async () => await onWorksChanged()}
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
