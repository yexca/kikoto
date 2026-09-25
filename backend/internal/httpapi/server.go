package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/accesspolicy"
	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/auththrottle"
	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type updateCheckCache struct {
	checkedAt time.Time
	result    appUpdateResponse
}

type Server struct {
	db                             *sql.DB
	accountStore                   *account.Store
	accessPolicy                   *accesspolicy.Store
	initialSetup                   initialSetupState
	loginThrottle                  *auththrottle.Limiter
	libraryStore                   *library.Store
	workflowStore                  *workflow.Store
	cfg                            config.Config
	dlsiteEndpoints                dlsite.Endpoints
	dlsiteClient                   metasync.DLsiteClient
	remoteWorkCacheMu              sync.Mutex
	remoteWorkCache                map[string]remoteWorkSnapshot
	remoteWorkCacheCalls           map[string]*remoteWorkCall
	remoteWorkTracksCache          map[string]remoteWorkTracksSnapshot
	remoteWorkTracksCacheCalls     map[string]*remoteWorkTracksCall
	remoteTrackMu                  sync.Mutex
	cachePathLocks                 cachePathLocker
	audioTranscodeLocks            cachePathLocker
	metadataSyncMu                 sync.Mutex
	metadataOnboardingMu           sync.Mutex
	metadataCoordinator            *metasync.Coordinator
	jobRunnerMu                    sync.Mutex
	jobRunnerStarted               bool
	workflowLeases                 *workflowLeaseRegistry
	voiceCatalogRefreshMu          sync.Mutex
	creatorRefreshMu               sync.Mutex
	fetchStagingCleanupMu          sync.Mutex
	sourceGate                     *sourceRequestGate
	sourceTransports               sourceTransportCache
	localMediaIndexMu              sync.Mutex
	localMediaIndexes              map[string]*localMediaIndexCall
	localMediaWriteSlot            chan struct{}
	localMediaProbeWake            chan struct{}
	mediaStreamCache               sync.Map
	realtimeResourceMu             sync.Mutex
	realtimeProbeSlots             chan struct{}
	realtimeProbeQueue             chan struct{}
	realtimeProbeCacheMu           sync.Mutex
	realtimeProbeCache             map[string]playbackProbeCacheEntry
	realtimeTranscodeSlots         chan struct{}
	realtimeTranscodeQueue         chan struct{}
	transcodeCacheActivityMu       sync.RWMutex
	transcodeCacheQuotaMu          sync.Mutex
	transcodeCacheReservedBytes    int64
	filesystemTriggerConfigChanged chan struct{}
	updateCheckMu                  sync.Mutex
	updateCheck                    *updateCheckCache
	updateHTTPClient               *http.Client
	appUpdateEndpoints             appUpdateEndpoints
	lifetime                       *serverLifetime
}

type localMediaIndexCall struct {
	done chan struct{}
	err  error
}

func NewServer(db *sql.DB, cfg config.Config) *Server {
	dlsiteEndpoints := dlsite.DefaultEndpoints()
	return &Server{
		db: db, accountStore: account.NewStore(db), accessPolicy: accesspolicy.NewStore(db), libraryStore: library.NewStore(db), workflowStore: workflow.NewStore(db), cfg: cfg,
		loginThrottle:                  auththrottle.New(),
		dlsiteEndpoints:                dlsiteEndpoints,
		dlsiteClient:                   dlsiteEndpoints.NewClient(nil),
		metadataCoordinator:            metasync.NewCoordinator(),
		remoteWorkCache:                map[string]remoteWorkSnapshot{},
		remoteWorkCacheCalls:           map[string]*remoteWorkCall{},
		remoteWorkTracksCache:          map[string]remoteWorkTracksSnapshot{},
		remoteWorkTracksCacheCalls:     map[string]*remoteWorkTracksCall{},
		localMediaIndexes:              map[string]*localMediaIndexCall{},
		realtimeProbeCache:             map[string]playbackProbeCacheEntry{},
		localMediaWriteSlot:            make(chan struct{}, 1),
		localMediaProbeWake:            make(chan struct{}, 1),
		workflowLeases:                 newWorkflowLeaseRegistry(),
		sourceGate:                     newSourceRequestGate(),
		filesystemTriggerConfigChanged: make(chan struct{}, 1),
		appUpdateEndpoints:             defaultAppUpdateEndpoints(),
		lifetime:                       newServerLifetime(),
	}
}

func (s *Server) newDLsiteClient() *dlsite.Client { return s.dlsiteEndpoints.NewClient(nil) }

// WarmSearchIndex builds queued Library search documents, including the full
// backlog queued when the index is first created, before users search.
func (s *Server) WarmSearchIndex(ctx context.Context) error {
	return s.libraryStore.RefreshSearchIndex(ctx)
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	// Routes registered with handleSlowFirstResponse may work past
	// apiFirstResponseBudget before responding, so they keep an unbounded
	// request context: synchronous transcodes, remote-source operations that
	// make several paced upstream requests, and filesystem maintenance scans or
	// deletions that should not stop halfway. Every other API route is bounded.
	slowFirstResponsePatterns := map[string]bool{}
	handleSlowFirstResponse := func(pattern string, handler http.HandlerFunc) {
		mux.HandleFunc(pattern, handler)
		slowFirstResponsePatterns[pattern] = true
	}
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /api/app-update", s.getAppUpdate)
	mux.HandleFunc("GET /api/auth/me", s.getCurrentUser)
	mux.HandleFunc("PATCH /api/auth/me", s.updateCurrentUser)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("POST /api/auth/setup", s.completeInitialSetup)
	mux.HandleFunc("PATCH /api/access-policy", s.updateAccessPolicy)
	mux.HandleFunc("GET /api/notifications", s.listNotifications)
	mux.HandleFunc("POST /api/notifications/clear-succeeded", s.clearSucceededNotifications)
	mux.HandleFunc("DELETE /api/notifications/{id}", s.dismissNotification)
	mux.HandleFunc("GET /api/remote-track-runs/{id}", s.getRemoteTrackRunStatus)
	mux.HandleFunc("GET /api/users", s.listUsers)
	mux.HandleFunc("POST /api/users", s.createUser)
	mux.HandleFunc("PATCH /api/users/{id}", s.updateUser)
	mux.HandleFunc("DELETE /api/users/{id}", s.deleteUser)
	mux.HandleFunc("GET /api/recently-played-works", s.listRecentlyPlayedWorks)
	mux.HandleFunc("GET /api/works", s.listWorks)
	mux.HandleFunc("GET /api/metadata/onboarding", s.getMetadataOnboarding)
	mux.HandleFunc("POST /api/metadata/onboarding/start", s.startMetadataOnboarding)
	mux.HandleFunc("POST /api/metadata/onboarding/dismiss", s.dismissMetadataOnboarding)
	mux.HandleFunc("GET /api/works/{id}", s.getWork)
	mux.HandleFunc("GET /api/works/{id}/recommendation", s.getWorkRecommendation)
	mux.HandleFunc("GET /api/works/{id}/playback-cursor", s.getWorkPlaybackCursor)
	mux.HandleFunc("POST /api/recommendation-events", s.recordRecommendationEvents)
	mux.HandleFunc("GET /api/recommendation-telemetry", s.getRecommendationTelemetry)
	mux.HandleFunc("GET /api/works/{id}/media", s.getWorkMedia)
	handleSlowFirstResponse("POST /api/works/{id}/local-files/refresh", s.refreshWorkLocalFiles)
	mux.HandleFunc("POST /api/works/{id}/metadata-sync", s.createWorkMetadataSyncRun)
	mux.HandleFunc("PUT /api/media/{id}/lyrics-preference", s.setMediaLyricsPreference)
	mux.HandleFunc("DELETE /api/media/{id}/lyrics-preference", s.clearMediaLyricsPreference)
	mux.HandleFunc("GET /api/works/{id}/manual-overrides", s.getWorkManualOverrides)
	mux.HandleFunc("PATCH /api/works/{id}/manual-overrides", s.updateWorkManualOverrides)
	mux.HandleFunc("DELETE /api/works/{id}/manual-overrides/{field}", s.deleteWorkManualOverride)
	mux.HandleFunc("GET /api/works/{id}/cover-candidates", s.listWorkCoverCandidates)
	mux.HandleFunc("POST /api/works/{id}/cover-override", s.setWorkCoverOverride)
	mux.HandleFunc("GET /api/metadata-suggestions/circles", s.suggestCircles)
	mux.HandleFunc("GET /api/metadata-suggestions/voices", s.suggestVoices)
	mux.HandleFunc("GET /api/metadata-suggestions/series", s.suggestSeries)
	mux.HandleFunc("GET /api/works/{code}/resolve", s.resolveWorkCode)
	mux.HandleFunc("GET /api/works/{code}/entity-links", s.lookupWorkEntityLink)
	handleSlowFirstResponse("POST /api/works/{code}/entity-links/resolve", s.resolveWorkEntityLink)
	mux.HandleFunc("GET /api/works/{code}/source-availability", s.getWorkSourceAvailability)
	handleSlowFirstResponse("POST /api/works/{code}/source-availability", s.checkWorkSourceAvailabilityNow)
	mux.HandleFunc("POST /api/maintenance/unlinked-works/source-check", s.checkUnlinkedWorkSources)
	mux.HandleFunc("POST /api/maintenance/unlinked-works/delete", s.deleteUnlinkedWorks)
	mux.HandleFunc("PATCH /api/works/{id}/user-state", s.updateWorkUserState)
	mux.HandleFunc("GET /api/tags", s.listUserTagVocabulary)
	mux.HandleFunc("PUT /api/works/{id}/tags", s.setWorkUserTags)
	mux.HandleFunc("GET /api/favorite-works", s.listFavoriteWorks)
	mux.HandleFunc("GET /api/favorite-lists", s.listFavoriteLists)
	mux.HandleFunc("POST /api/favorite-lists", s.createFavoriteList)
	mux.HandleFunc("PATCH /api/favorite-lists/{id}", s.updateFavoriteList)
	mux.HandleFunc("DELETE /api/favorite-lists/{id}", s.deleteFavoriteList)
	mux.HandleFunc("GET /api/favorite-lists/{id}/work-ids", s.listFavoriteListWorkIDs)
	mux.HandleFunc("POST /api/favorite-lists/membership", s.updateFavoriteListMembership)
	mux.HandleFunc("POST /api/favorite-lists/membership/summary", s.summarizeFavoriteListMembership)
	mux.HandleFunc("GET /api/works/{id}/favorite-lists", s.getWorkFavoriteLists)
	mux.HandleFunc("PUT /api/works/{id}/favorite-lists", s.setWorkFavoriteLists)
	mux.HandleFunc("GET /api/circles", s.listCircles)
	mux.HandleFunc("GET /api/circles/{externalId}", s.getCircle)
	mux.HandleFunc("PATCH /api/circles/{externalId}/user-state", s.updateCircleUserState)
	mux.HandleFunc("PUT /api/circles/{externalId}/tags", s.setCircleUserTags)
	mux.HandleFunc("POST /api/circles/{externalId}/refresh", s.refreshCircle)
	mux.HandleFunc("DELETE /api/circles/{externalId}/catalog/{code}", s.deleteCircleCatalogWork)
	mux.HandleFunc("GET /api/voices", s.listVoices)
	mux.HandleFunc("GET /api/voices/{personId}", s.getVoice)
	mux.HandleFunc("GET /api/voices/{personId}/works", s.getVoiceWorks)
	mux.HandleFunc("GET /api/voices/{personId}/remote-matches", s.getVoiceRemoteMatches)
	mux.HandleFunc("POST /api/voices/{personId}/catalog/refresh", s.refreshVoiceCatalog)
	mux.HandleFunc("GET /api/voices/{personId}/alias-candidates", s.listVoiceAliasCandidates)
	mux.HandleFunc("POST /api/voices/{personId}/aliases", s.createVoiceAlias)
	mux.HandleFunc("DELETE /api/voices/{personId}/aliases/{aliasId}", s.deleteVoiceAlias)
	mux.HandleFunc("POST /api/voices/{personId}/merge", s.mergeVoiceAliasCandidate)
	mux.HandleFunc("GET /api/voices/{personId}/merges", s.listVoiceMergeReviews)
	mux.HandleFunc("POST /api/voices/{personId}/merges/{mergeId}/undo", s.undoVoiceMergeReview)
	mux.HandleFunc("PATCH /api/voices/{personId}/user-state", s.updateVoiceUserState)
	mux.HandleFunc("PUT /api/voices/{personId}/tags", s.setVoiceUserTags)
	mux.HandleFunc("GET /api/assets/covers/", s.getCoverAsset)
	mux.HandleFunc("GET /api/assets/manual/{file}", s.getManualAsset)
	handleSlowFirstResponse("GET /api/media/{id}/stream", s.streamMedia)
	mux.HandleFunc("GET /api/media/{id}/playback", s.getVideoPlaybackInfo)
	handleSlowFirstResponse("GET /api/media/{id}/hls/{file}", s.serveVideoHLS)
	mux.HandleFunc("POST /api/media/{id}/cache", s.cacheMediaLocation)
	mux.HandleFunc("DELETE /api/media/{id}/cache", s.deleteMediaCacheLocation)
	mux.HandleFunc("DELETE /api/media/{id}/local", s.deleteMediaLocalLocation)
	mux.HandleFunc("POST /api/media/cleanup", s.cleanupMediaLocations)
	handleSlowFirstResponse("GET /api/cache/overview", s.getCacheOverview)
	handleSlowFirstResponse("GET /api/maintenance/database", s.getDatabaseMaintenance)
	handleSlowFirstResponse("POST /api/maintenance/database/cleanup", s.cleanupDatabase)
	mux.HandleFunc("POST /api/maintenance/database/optimize", s.optimizeDatabase)
	handleSlowFirstResponse("POST /api/cache/cleanup", s.cleanupOrphanCache)
	handleSlowFirstResponse("DELETE /api/cache/transcodes", s.clearTranscodeCache)
	mux.HandleFunc("GET /api/media/{id}/asset", s.serveMediaAsset)
	mux.HandleFunc("GET /api/media/{id}/text", s.serveMediaText)
	mux.HandleFunc("GET /api/media/{id}/download", s.downloadMedia)
	mux.HandleFunc("PATCH /api/media-items/{id}/progress", s.updateMediaProgress)
	mux.HandleFunc("GET /api/auth/me/preferences", s.getUserPreferences)
	mux.HandleFunc("PATCH /api/auth/me/preferences", s.updateUserPreferences)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("GET /api/runtime-settings", s.getRuntimeSettings)
	handleSlowFirstResponse("PATCH /api/settings", s.updateSettings)
	mux.HandleFunc("GET /api/library-sources", s.listLibrarySources)
	mux.HandleFunc("GET /api/file-sources", s.listFileSources)
	mux.HandleFunc("POST /api/file-sources", s.createFileSource)
	mux.HandleFunc("POST /api/file-sources/detect", s.detectFileSource)
	mux.HandleFunc("PATCH /api/file-sources/{id}", s.updateFileSource)
	mux.HandleFunc("DELETE /api/file-sources/{id}", s.deleteFileSource)
	mux.HandleFunc("POST /api/file-sources/{id}/health-check", s.checkFileSourceHealth)
	handleSlowFirstResponse("GET /api/remote-sources/{id}/works", s.listRemoteSourceWorks)
	handleSlowFirstResponse("GET /api/remote-sources/{id}/works/{code}", s.getRemoteSourceWork)
	handleSlowFirstResponse("GET /api/remote-sources/{id}/works/{code}/tracks", s.getRemoteSourceWorkTracks)
	handleSlowFirstResponse("GET /api/remote-sources/{id}/works/{code}/media", s.streamRemoteSourceMedia)
	handleSlowFirstResponse("GET /api/remote-sources/{id}/works/{code}/text", s.getRemoteSourceWorkText)
	handleSlowFirstResponse("POST /api/remote-sources/{id}/works/{code}/save-plan", s.planRemoteSourceWorkSave)
	handleSlowFirstResponse("POST /api/remote-sources/{id}/works/{code}/save", s.saveRemoteSourceWork)
	handleSlowFirstResponse("POST /api/remote-sources/{id}/works/{code}/fetch-plan", s.planRemoteSourceWorkSave)
	handleSlowFirstResponse("POST /api/remote-sources/{id}/works/{code}/fetch", s.saveRemoteSourceWork)
	mux.HandleFunc("POST /api/remote-sources/{id}/works/{code}/track", s.trackRemoteSourceWork)
	handleSlowFirstResponse("POST /api/remote-sources/{id}/works/{code}/sync", s.syncRemoteSourceWork)
	handleSlowFirstResponse("POST /api/remote-sources/{id}/works/{code}/cache", s.cacheRemoteSourceWorkMedia)
	handleSlowFirstResponse("DELETE /api/works/{id}/tracked-sources/{sourceId}", s.untrackWorkSource)
	mux.HandleFunc("GET /api/workflow-definitions", s.listWorkflowDefinitions)
	mux.HandleFunc("GET /api/workflow-presets", s.listWorkflowPresets)
	mux.HandleFunc("POST /api/workflow-presets/{code}/runs", s.runWorkflowPreset)
	mux.HandleFunc("GET /api/workflow-triggers", s.listWorkflowTriggers)
	mux.HandleFunc("POST /api/workflow-triggers", s.createWorkflowTrigger)
	mux.HandleFunc("PATCH /api/workflow-triggers/{id}", s.updateWorkflowTrigger)
	mux.HandleFunc("DELETE /api/workflow-triggers/{id}", s.deleteWorkflowTrigger)
	mux.HandleFunc("GET /api/workflow-runs", s.listWorkflowRuns)
	mux.HandleFunc("GET /api/metadata/issues", s.listMetadataIssues)
	mux.HandleFunc("GET /api/maintenance/works", s.listWorkMaintenance)
	mux.HandleFunc("POST /api/metadata/issues/retry", s.retryMetadataIssues)
	mux.HandleFunc("GET /api/workflow-runs/{id}", s.getWorkflowRun)
	mux.HandleFunc("GET /api/workflow-runs/{id}/events", s.listWorkflowRunEvents)
	mux.HandleFunc("GET /api/workflow-runs/{id}/events/stream", s.streamWorkflowRunEvents)
	mux.HandleFunc("GET /api/workflow-runs/{id}/candidates", s.listWorkflowRunCandidates)
	mux.HandleFunc("POST /api/workflow-runs/{id}/cancel", s.cancelWorkflowRun)
	mux.HandleFunc("POST /api/workflow-runs/{id}/retry", s.retryWorkflowRun)
	mux.HandleFunc("POST /api/workflow-runs/{id}/review", s.reviewWorkflowRun)
	mux.HandleFunc("POST /api/workflow-runs/recover-stale", s.recoverStaleWorkflowRuns)
	mux.HandleFunc("PATCH /api/workflow-candidates/{id}", s.updateWorkflowCandidate)
	mux.HandleFunc("POST /api/workflow-candidates/{id}/local-cleanup", s.cleanupLocalWorkflowCandidate)
	handleSlowFirstResponse("POST /api/workflow-candidates/{id}/archived-root-review", s.reviewArchivedFetchRoots)
	mux.HandleFunc("POST /api/workflow-runs/local-scan", s.createLocalScanRun)
	mux.HandleFunc("POST /api/workflow-runs/local-media-index", s.createLocalMediaIndexRun)
	mux.HandleFunc("POST /api/workflow-runs/remote-bulk", s.createRemoteBulkRun)
	mux.HandleFunc("POST /api/workflow-runs/remote-popular", s.createRemotePopularCollectionRun)
	mux.HandleFunc("POST /api/workflow-runs/dlsite-popular", s.createDLsitePopularCollectionRun)
	mux.HandleFunc("POST /api/workflow-runs/dlsite-sync", s.createDLsiteSyncRun)
	mux.HandleFunc("GET /api/availability-watch", s.getAvailabilityWatch)
	mux.HandleFunc("PUT /api/availability-watch", s.updateAvailabilityWatch)
	mux.HandleFunc("PUT /api/availability-watch/targets", s.updateAvailabilityWatchTargets)
	mux.HandleFunc("DELETE /api/availability-watch/targets/{id}", s.deleteAvailabilityWatchTarget)
	mux.HandleFunc("POST /api/availability-watch/targets/{id}/track", s.trackAvailabilityWatchTarget)
	mux.HandleFunc("POST /api/availability-watch/run", s.runAvailabilityWatch)
	apiHandler := s.withCORS(withFirstResponseDeadline(
		limitRequestBody(s.authMiddleware(s.anonymousAccessMiddleware(s.demoReadOnlyMiddleware(s.demoContentMiddleware(mux)))), maxJSONRequestBytes),
		mux, apiFirstResponseBudget, slowFirstResponsePatterns,
	))
	if strings.TrimSpace(s.cfg.StaticDir) == "" {
		return withGzip(apiHandler)
	}
	return withGzip(s.staticAppHandler(apiHandler))
}

const (
	// Vite emits content-hashed file names under /assets/, so a URL never
	// changes meaning and may be cached for a year.
	staticImmutableCacheControl = "public, max-age=31536000, immutable"
	// The app shell, service worker, and manifest must be revalidated so a
	// deploy is picked up on the next navigation.
	staticRevalidateCacheControl = "no-cache"
	staticDefaultCacheControl    = "public, max-age=3600"
)

func staticCacheControl(requestPath string) string {
	switch {
	case strings.HasPrefix(requestPath, "/assets/"):
		return staticImmutableCacheControl
	case requestPath == "/sw.js", requestPath == "/manifest.webmanifest", strings.HasSuffix(requestPath, ".html"):
		return staticRevalidateCacheControl
	default:
		return staticDefaultCacheControl
	}
}

func (s *Server) staticAppHandler(apiHandler http.Handler) http.Handler {
	staticRoot := strings.TrimSpace(s.cfg.StaticDir)
	indexPath := filepath.Join(staticRoot, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || strings.HasPrefix(r.URL.Path, "/api/") {
			apiHandler.ServeHTTP(w, r)
			return
		}

		requestPath := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/"))
		relPath := strings.TrimPrefix(requestPath, "/")
		candidate, err := safeStaticPath(staticRoot, relPath)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			w.Header().Set("Cache-Control", staticCacheControl(requestPath))
			if path.Ext(requestPath) == ".webmanifest" {
				w.Header().Set("Content-Type", "application/manifest+json")
			}
			http.ServeFile(w, r, candidate)
			return
		}
		// A missing hashed asset is a stale or mistyped URL, not an app route;
		// answering with the HTML shell would be cached as a script or style.
		if strings.HasPrefix(requestPath, "/assets/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", staticRevalidateCacheControl)
		http.ServeFile(w, r, indexPath)
	})
}

func safeStaticPath(root string, relPath string) (string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes static root")
	}
	return absPath, nil
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": buildinfo.Version})
}

func (s *Server) RunStartupWorkflows(ctx context.Context) error {
	if err := s.ensureSystemWorkflowDefinitions(ctx); err != nil {
		return err
	}
	if err := s.dispatchStartupSystemWorkflowTriggers(ctx); err != nil {
		return err
	}
	return s.syncVoiceCreditsFromSnapshots(ctx)
}

func (s *Server) RecoverInterruptedWorkflows(ctx context.Context) error {
	if _, err := s.settleInterruptedWorkflowRuns(ctx, "startup interrupted before completion"); err != nil {
		return err
	}
	if err := s.reconcileRemoteFetchManifests(ctx); err != nil {
		return err
	}
	_, err := s.cleanupExpiredRemoteFetchStaging(ctx, time.Now())
	return err
}

func safeDataPath(root string, relPath string) (string, error) {
	if strings.TrimSpace(relPath) == "" || filepath.IsAbs(relPath) {
		return "", fmt.Errorf("invalid relative path")
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil {
		return "", err
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", fmt.Errorf("path escapes data root")
	}
	return absPath, nil
}

func safeCachePath(root string, relPath string) (string, error) {
	if strings.TrimSpace(relPath) == "" || filepath.IsAbs(relPath) {
		return "", fmt.Errorf("invalid relative path")
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil {
		return "", err
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", fmt.Errorf("path escapes cache root")
	}
	return absPath, nil
}
