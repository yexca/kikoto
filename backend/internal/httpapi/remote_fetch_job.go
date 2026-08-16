package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

type remoteWorkFetchExecution struct {
	source        remoteSourceForUse
	manifest      remoteFetchManifestRecord
	plan          remoteWorkSavePlan
	workCode      string
	workID        int64
	localSourceID int64
	cacheNodeID   int64
	promoteNodeID int64
	syncNodeID    int64
	cleanupNodeID int64
	downloadLimit int64
	byteProgress  *remoteFetchByteProgress
}

type remoteFetchMaterializeCounts struct {
	skipped        int
	cacheHits      int
	cacheDownloads int
}

type remoteFetchItemOutcome struct {
	skipped         bool
	cacheHit        bool
	cacheDownloaded bool
}

func (s *Server) prepareRemoteWorkFetchExecution(
	ctx context.Context,
	runID int64,
	jobID int64,
	payload remoteWorkFetchJobPayload,
) (remoteWorkFetchExecution, error) {
	execution := remoteWorkFetchExecution{workCode: strings.ToUpper(strings.TrimSpace(payload.WorkCode))}
	source, err := s.loadRemoteSourceForUse(ctx, payload.SourceID)
	if err != nil {
		return execution, err
	}
	execution.source = source
	manifest, manifestErr := s.loadRemoteFetchManifest(ctx, runID)
	var plan remoteWorkSavePlan
	if manifestErr == nil && strings.TrimSpace(manifest.ErrorMessage) == "" {
		manifestErr = json.Unmarshal([]byte(manifest.PlanJSON), &plan)
	}
	if manifestErr != nil || plan.PrimaryCode == "" {
		var remoteWork kikoeru.Work
		var tracks []kikoeru.Track
		source, remoteWork, tracks, err = s.loadRemoteWorkTracksCached(ctx, payload.SourceID, payload.WorkCode)
		if err != nil {
			return execution, err
		}
		execution.source = source
		if normalized := normalizedRemoteWorkCode(remoteWork); normalized != "" {
			execution.workCode = normalized
		}
		plan, err = s.buildRemoteWorkSavePlanFromSnapshot(ctx, source, remoteWork, tracks, execution.workCode, payload.Paths, payload.LocalPaths, payload.TargetRoot, payload.Decisions)
		if err != nil {
			return execution, err
		}
		if manifest.ID > 0 {
			if err := s.refreshRemoteFetchManifestPlan(ctx, manifest.ID, plan); err != nil {
				return execution, err
			}
			manifest, err = s.loadRemoteFetchManifest(ctx, runID)
			if err != nil {
				return execution, err
			}
		}
	}
	if plan.Summary.Conflict > 0 {
		return execution, remoteWorkSaveConflictError{Summary: plan.Summary}
	}
	downloadLimit := s.remoteMediaDownloadLimitBytes(ctx)
	if err := validateRemoteFetchDownloadPlan(plan.Items, downloadLimit); err != nil {
		return execution, err
	}
	if err := s.ensureRemoteWorkSaveDiskReserve(plan, payload.MinFreeBytes); err != nil {
		return execution, err
	}
	workID, localSourceID, cacheNodeID, promoteNodeID, syncNodeID, cleanupNodeID, err := s.preparePersistedRemoteWorkFetchJob(ctx, runID, manifest)
	if err != nil {
		return execution, err
	}
	byteProgress, err := newRemoteFetchByteProgress(ctx, s, jobID, cacheNodeID, plan.Items)
	if err != nil {
		return execution, err
	}
	execution.manifest = manifest
	execution.plan = plan
	execution.workID = workID
	execution.localSourceID = localSourceID
	execution.cacheNodeID = cacheNodeID
	execution.promoteNodeID = promoteNodeID
	execution.syncNodeID = syncNodeID
	execution.cleanupNodeID = cleanupNodeID
	execution.downloadLimit = downloadLimit
	execution.byteProgress = byteProgress
	return execution, nil
}

func (s *Server) materializeRemoteWorkFetch(
	ctx context.Context,
	runID int64,
	jobID int64,
	execution remoteWorkFetchExecution,
) (remoteFetchMaterializeCounts, error) {
	counts := remoteFetchMaterializeCounts{}
	downloadSources := map[int64]remoteSourceForUse{execution.source.ID: execution.source}
	for index, item := range execution.plan.Items {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return counts, err
		}
		outcome, err := s.materializeRemoteWorkFetchItem(ctx, runID, jobID, execution, index, item, downloadSources)
		if err != nil {
			return counts, err
		}
		if outcome.skipped {
			counts.skipped++
		}
		if outcome.cacheHit {
			counts.cacheHits++
		}
		if outcome.cacheDownloaded {
			counts.cacheDownloads++
		}
	}
	return counts, nil
}

func (s *Server) materializeRemoteWorkFetchItem(
	ctx context.Context,
	runID int64,
	jobID int64,
	execution remoteWorkFetchExecution,
	index int,
	item remoteWorkSavePlanItem,
	downloadSources map[int64]remoteSourceForUse,
) (remoteFetchItemOutcome, error) {
	totalProgress := len(execution.plan.Items) * 2
	markProgress := func() {
		_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, totalProgress)
		_ = s.updateWorkflowJobCheckpoint(ctx, jobID, "materialize", map[string]any{
			"index": index + 1, "itemKey": item.ItemKey, "action": item.Action,
		}, index+1, totalProgress)
	}
	if item.Action == "skip" || item.Action == "exclude" {
		markProgress()
		return remoteFetchItemOutcome{skipped: true}, nil
	}
	if item.Action == "copy_local" {
		markProgress()
		return remoteFetchItemOutcome{}, nil
	}
	_ = s.updateRemoteFetchCacheProgress(ctx, execution.cacheNodeID, index, len(execution.plan.Items), item, 0)
	cacheAbsPath, err := safeCachePath(s.cfg.CacheRoot, item.CachePath)
	if err != nil {
		return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
	}
	if item.Action == "cache_hit" {
		_ = s.updateRemoteFetchCacheProgress(ctx, execution.cacheNodeID, index+1, len(execution.plan.Items), item, 0)
		markProgress()
		return remoteFetchItemOutcome{cacheHit: true}, nil
	}
	if err := os.MkdirAll(filepath.Dir(cacheAbsPath), 0o755); err != nil {
		return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
	}
	if err := execution.byteProgress.begin(index, item); err != nil {
		return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
	}
	downloadSourceID := remoteFetchItemSourceID(item, execution.source.ID)
	downloadSource, ok := downloadSources[downloadSourceID]
	if !ok {
		downloadSource, err = s.loadRemoteSourceForUse(ctx, downloadSourceID)
		if err != nil {
			return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
		}
		downloadSources[downloadSourceID] = downloadSource
	}
	written, err := s.downloadToFile(ctx, downloadSource, item.SourcePath, cacheAbsPath, remoteDownloadOptions{
		MaxBytes:      execution.downloadLimit,
		ExpectedBytes: item.SizeBytes,
		OnProgress: func(written int64) {
			execution.byteProgress.report(index, item, written)
		},
	})
	if err != nil {
		execution.byteProgress.abort(index, item)
		var blockedOrigin outbound.OriginNotAllowedError
		if downloadSource.Endpoint.RestrictOutboundHosts && errors.As(err, &blockedOrigin) {
			slog.Warn("remote Fetch origin blocked by source policy", "run_id", runID, "job_id", jobID, "source_id", downloadSource.ID, "origin", blockedOrigin.Origin, "error", err)
			if pauseErr := s.pauseRemoteFetchForOriginReview(ctx, runID, execution.cacheNodeID, jobID, execution.manifest.ID, downloadSource, blockedOrigin.Origin, index, totalProgress, execution.plan.Summary); pauseErr != nil {
				return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, pauseErr)
			}
			return remoteFetchItemOutcome{}, remoteOriginReviewError{Origin: blockedOrigin.Origin}
		}
		_ = s.recordRemoteFetchManifestError(ctx, execution.manifest.ID, err)
		return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
	}
	if err := execution.byteProgress.complete(index+1, item, written); err != nil {
		return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
	}
	mediaItemID, err := s.mediaItemIDForRemotePath(ctx, execution.workID, item.Path)
	if err != nil {
		return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
	}
	cacheSourceID := remoteFetchItemSourceID(item, execution.source.ID)
	cacheLocationID, err := s.upsertCacheLocation(ctx, mediaItemID, cacheSourceID, item.CachePath, "", item.SizeBytes, nil, written)
	if err != nil {
		return remoteFetchItemOutcome{}, s.failRemoteFetchMaterialization(ctx, runID, execution.cacheNodeID, jobID, index, totalProgress, execution.plan.Summary, err)
	}
	_, _ = s.runCacheLimitCleanup(ctx, cacheSourceID, cacheLocationID)
	_ = s.updateRemoteFetchCacheProgress(ctx, execution.cacheNodeID, index+1, len(execution.plan.Items), item, written)
	markProgress()
	return remoteFetchItemOutcome{cacheDownloaded: true}, nil
}

func remoteFetchItemSourceID(item remoteWorkSavePlanItem, fallback int64) int64 {
	if item.RemoteSourceID > 0 {
		return item.RemoteSourceID
	}
	return fallback
}

func (s *Server) failRemoteFetchMaterialization(
	ctx context.Context,
	runID int64,
	nodeID int64,
	jobID int64,
	current int,
	total int,
	summary remoteWorkSaveSummary,
	err error,
) error {
	_ = finishWorkflowRunSimple(ctx, s.db, runID, nodeID, jobID, "failed", err.Error(), current, total, summary)
	return err
}

func (s *Server) finalizeRemoteWorkFetch(
	ctx context.Context,
	runID int64,
	jobID int64,
	execution remoteWorkFetchExecution,
	counts remoteFetchMaterializeCounts,
) (remoteWorkSaveResult, error) {
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{
		"skipped": counts.skipped, "cache_hits": counts.cacheHits, "cache_downloads": counts.cacheDownloads,
		"bytes_current": execution.byteProgress.current, "bytes_total": execution.byteProgress.total, "bytes_unknown_items": execution.byteProgress.unknownItems,
	}), execution.cacheNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	manifest := execution.manifest
	if manifest.ID <= 0 {
		var err error
		manifest, err = s.loadRemoteFetchManifest(ctx, runID)
		if err != nil {
			return remoteWorkSaveResult{}, s.failRemoteWorkFetchPhase(ctx, runID, execution.promoteNodeID, jobID, len(execution.plan.Items), len(execution.plan.Items)*2, execution.plan.Summary, err)
		}
	}
	promoted, err := s.stageAndPublishRemoteFetch(ctx, manifest, execution.plan)
	if err != nil {
		return remoteWorkSaveResult{}, s.failRemoteWorkFetchPhase(ctx, runID, execution.promoteNodeID, jobID, len(execution.plan.Items), len(execution.plan.Items)*2, execution.plan.Summary, err)
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, jobID, "published", map[string]any{"targetRoot": execution.plan.SaveRoot, "promoted": promoted}, len(execution.plan.Items), len(execution.plan.Items)*2)
	_ = updateWorkflowJobProgress(ctx, s.db, jobID, len(execution.plan.Items)*2, len(execution.plan.Items)*2)
	if err := s.markRemoteFetchPublished(ctx, jobID, execution.promoteNodeID, execution.plan, promoted); err != nil {
		return remoteWorkSaveResult{}, err
	}
	syncedLocations, err := s.syncRemoteWorkFetchLocations(ctx, runID, jobID, execution, manifest)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	removedCache, err := s.cleanupPromotedFetchCache(ctx, execution.plan, execution.workID)
	if err != nil {
		failedNodeID := execution.cleanupNodeID
		if failedNodeID == 0 {
			failedNodeID = execution.syncNodeID
		}
		return remoteWorkSaveResult{}, s.failRemoteWorkFetchPhase(ctx, runID, failedNodeID, jobID, len(execution.plan.Items)*2, len(execution.plan.Items)*2, execution.plan.Summary, err)
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, jobID, "cache_cleaned", map[string]any{"removed": removedCache}, len(execution.plan.Items)*2, len(execution.plan.Items)*2)
	if err := s.finishRemoteWorkFetch(ctx, runID, jobID, execution, manifest, counts, promoted, removedCache, syncedLocations); err != nil {
		return remoteWorkSaveResult{}, err
	}
	return remoteWorkSaveResult{
		RunID: runID, JobID: jobID, WorkID: execution.workID, PrimaryCode: execution.workCode,
		Status: "succeeded", SaveRoot: execution.plan.SaveRoot, SavedFiles: promoted,
		SkippedFiles: counts.skipped, CachedFiles: counts.cacheHits + counts.cacheDownloads,
		PromotedFiles: promoted, Plan: execution.plan.Summary,
	}, nil
}

func (s *Server) markRemoteFetchPublished(ctx context.Context, jobID, nodeID int64, plan remoteWorkSavePlan, promoted int) error {
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"staged": promoted, "verified": promoted, "published": promoted, "target_root": plan.SaveRoot}), nodeID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "UPDATE workflow_job SET progress_current = ?, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", len(plan.Items)*2, len(plan.Items)*2, jobID)
	return err
}

func (s *Server) syncRemoteWorkFetchLocations(
	ctx context.Context,
	runID int64,
	jobID int64,
	execution remoteWorkFetchExecution,
	manifest remoteFetchManifestRecord,
) (int, error) {
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", execution.syncNodeID); err != nil {
		return 0, err
	}
	syncedLocations := 0
	for index, item := range execution.plan.Items {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return 0, err
		}
		if item.Action == "exclude" {
			continue
		}
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			return 0, s.failRemoteWorkFetchPhase(ctx, runID, execution.syncNodeID, jobID, len(execution.plan.Items)+index, len(execution.plan.Items)*2, execution.plan.Summary, err)
		}
		if _, err := os.Stat(targetAbsPath); err != nil {
			if item.Action == "skip" && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return 0, s.failRemoteWorkFetchPhase(ctx, runID, execution.syncNodeID, jobID, len(execution.plan.Items)+index, len(execution.plan.Items)*2, execution.plan.Summary, err)
		}
		if err := s.upsertSavedLocalLocation(ctx, execution.workID, execution.localSourceID, item, targetAbsPath); err != nil {
			return 0, s.failRemoteWorkFetchPhase(ctx, runID, execution.syncNodeID, jobID, len(execution.plan.Items)+index, len(execution.plan.Items)*2, execution.plan.Summary, err)
		}
		syncedLocations++
	}
	if err := s.finishFetchPresence(ctx, execution.workID, remoteFetchPlanSourceIDs(execution.plan, execution.source.ID), execution.localSourceID, execution.workCode); err != nil {
		return 0, s.failRemoteWorkFetchPhase(ctx, runID, execution.syncNodeID, jobID, len(execution.plan.Items)*2, len(execution.plan.Items)*2, execution.plan.Summary, err)
	}
	return syncedLocations, nil
}

func (s *Server) finishRemoteWorkFetch(
	ctx context.Context,
	runID int64,
	jobID int64,
	execution remoteWorkFetchExecution,
	manifest remoteFetchManifestRecord,
	counts remoteFetchMaterializeCounts,
	promoted int,
	removedCache int,
	syncedLocations int,
) error {
	if execution.cleanupNodeID > 0 {
		if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"removed": removedCache}), execution.cleanupNodeID); err != nil {
			return err
		}
	}
	if err := s.completeRemoteFetchManifest(ctx, manifest); err != nil {
		return s.failRemoteWorkFetchPhase(ctx, runID, execution.syncNodeID, jobID, len(execution.plan.Items)*2, len(execution.plan.Items)*2, execution.plan.Summary, err)
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, jobID, "registered", map[string]any{"locations": syncedLocations}, len(execution.plan.Items)*2, len(execution.plan.Items)*2)
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"locations": syncedLocations}), execution.syncNodeID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE workflow_job SET status = 'succeeded', progress_current = ?, progress_total = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, len(execution.plan.Items)*2, len(execution.plan.Items)*2, jobID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{
		"plan": execution.plan.Summary, "skipped": counts.skipped, "cache_hits": counts.cacheHits,
		"cache_downloads": counts.cacheDownloads, "cache_removed": removedCache, "promoted": promoted,
		"snapshot_bytes": len(manifest.PlanJSON),
	}), runID); err != nil {
		return err
	}
	return s.insertFetchCleanupCandidate(ctx, runID, execution.workID, execution.localSourceID, execution.workCode, execution.plan.Items)
}

func (s *Server) failRemoteWorkFetchPhase(ctx context.Context, runID, nodeID, jobID int64, current, total int, summary remoteWorkSaveSummary, err error) error {
	_ = finishWorkflowRunSimple(ctx, s.db, runID, nodeID, jobID, "failed", err.Error(), current, total, summary)
	return err
}
