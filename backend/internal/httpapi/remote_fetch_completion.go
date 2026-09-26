package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// Both startup recovery and an executing retry reconcile publication before
// consulting the remote source or cache. Once the target is published, only
// local registration and completion remain, even if those inputs are gone.
func (s *Server) resumeRemoteFetchPublication(ctx context.Context, manifest remoteFetchManifestRecord) (remoteWorkSaveResult, bool, error) {
	manifest, err := s.settleInterruptedRemoteFetchPublication(ctx, manifest)
	if err != nil {
		return remoteWorkSaveResult{}, false, err
	}
	switch manifest.State {
	case "published", "registered", "completed":
		var plan remoteWorkSavePlan
		if err := json.Unmarshal([]byte(manifest.PlanJSON), &plan); err != nil {
			return remoteWorkSaveResult{}, true, err
		}
		result, err := s.finishPublishedRemoteFetch(ctx, manifest, plan, nil)
		return result, true, err
	default:
		return remoteWorkSaveResult{}, false, nil
	}
}

func (s *Server) finishPublishedRemoteFetch(ctx context.Context, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan, counts *remoteFetchMaterializeCounts) (remoteWorkSaveResult, error) {
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, manifest.WorkflowRunID)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	fail := func(node string, err error) (remoteWorkSaveResult, error) {
		return remoteWorkSaveResult{}, s.failRemoteWorkFetchPhase(ctx, manifest.WorkflowRunID, nodeIDs[node], manifest.WorkflowJobID, len(plan.Items)*2, len(plan.Items)*2, plan.Summary, err)
	}
	if err := s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "sync", "running", nil); err != nil {
		return remoteWorkSaveResult{}, err
	}
	syncedLocations := 0
	for _, item := range plan.Items {
		if err := ctx.Err(); err != nil {
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "exclude" {
			continue
		}
		target, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			return fail("sync", err)
		}
		if _, err := os.Stat(target); err != nil {
			if item.Action == "skip" && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return fail("sync", err)
		}
		if err := s.upsertSavedLocalLocation(ctx, manifest.WorkID, manifest.LocalSourceID, item, target); err != nil {
			return fail("sync", err)
		}
		syncedLocations++
	}
	if err := s.finishFetchPresence(ctx, manifest.WorkID, remoteFetchPlanSourceIDs(plan, manifest.RemoteSourceID), manifest.LocalSourceID, manifest.EditionCode); err != nil {
		return fail("sync", err)
	}
	if err := s.registerRemoteFetchFolder(ctx, manifest); err != nil {
		return fail("sync", err)
	}
	removedCache, err := s.cleanupPromotedFetchCache(ctx, plan, manifest.WorkID)
	if err != nil {
		return fail("cleanup", err)
	}
	if err := s.insertFetchCleanupCandidate(ctx, manifest.WorkflowRunID, manifest.WorkID, manifest.LocalSourceID, manifest.EditionCode, plan.Items); err != nil {
		return fail("cleanup", err)
	}
	recovered := counts == nil
	if counts == nil {
		counts = &remoteFetchMaterializeCounts{}
		for _, item := range plan.Items {
			switch item.Action {
			case "skip", "exclude":
				counts.skipped++
			case "cache_hit":
				counts.cacheHits++
			case "cache_download":
				counts.cacheDownloads++
			}
		}
	}
	promoted := countPromotedFetchItems(plan.Items)
	summary := map[string]any{
		"plan": plan.Summary, "skipped": counts.skipped, "cache_hits": counts.cacheHits,
		"cache_downloads": counts.cacheDownloads, "cache_removed": removedCache, "promoted": promoted,
		"snapshot_bytes": len(manifest.PlanJSON),
	}
	if recovered {
		summary["recovered"] = true
		summary["published"] = promoted
	}
	if err := s.completeRemoteFetchManifest(ctx, manifest, plan, summary, syncedLocations, removedCache); err != nil {
		return remoteWorkSaveResult{}, err
	}
	// Publication no longer depends on cache inputs. Apply its global limit
	// only after every selected file has been registered.
	_, _ = s.runCacheLimitCleanup(ctx, manifest.RemoteSourceID, 0)
	return remoteWorkSaveResult{
		RunID: manifest.WorkflowRunID, JobID: manifest.WorkflowJobID, WorkID: manifest.WorkID,
		PrimaryCode: manifest.EditionCode, Status: "succeeded", SaveRoot: manifest.TargetRoot,
		SavedFiles: promoted, PromotedFiles: promoted, SkippedFiles: counts.skipped,
		CachedFiles: counts.cacheHits + counts.cacheDownloads, Plan: plan.Summary,
	}, nil
}

// A completed manifest must never get ahead of its workflow result. Retiring
// remote identities and releasing the job lease belong to the same commit.
func finishRemoteFetchWorkflowTx(ctx context.Context, tx *sql.Tx, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan, summary any, locations, removedCache int) error {
	outputs := map[string]any{
		"cache": map[string]any{}, "stage": map[string]any{}, "verify": map[string]any{},
		"promote": map[string]any{"published": countPromotedFetchItems(plan.Items), "target_root": manifest.TargetRoot},
		"sync":    map[string]any{"locations": locations}, "cleanup": map[string]any{"removed": removedCache},
	}
	for node, output := range outputs {
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run
			SET status = 'succeeded', output_json = json_patch(COALESCE(NULLIF(output_json, ''), '{}'), ?),
				error_message = '', finished_at = CURRENT_TIMESTAMP
			WHERE workflow_run_id = ? AND node_id = ?`, mustJSON(output), manifest.WorkflowRunID, node); err != nil {
			return err
		}
	}
	progress := len(plan.Items) * 2
	checkpoint := mustJSON(map[string]any{
		"phase": "registered", "detail": map[string]any{"locations": locations},
		"progressCurrent": progress, "progressTotal": progress, "updatedAt": time.Now().UTC().Format(time.RFC3339Nano),
	})
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_job SET checkpoint_json = ? WHERE id = ?`, checkpoint, manifest.WorkflowJobID); err != nil {
		return err
	}
	return finishWorkflowRunResultTx(ctx, tx, manifest.WorkflowRunID, manifest.WorkflowJobID, "succeeded", "", progress, progress, mustJSON(summary))
}

func (s *Server) completeRemoteFetchManifest(ctx context.Context, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan, summary any, locations, removedCache int) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := retireFetchRemoteStreams(ctx, tx, manifest.WorkID, remoteFetchPlanSourceIDs(plan, manifest.RemoteSourceID)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = 'completed', registered_at = COALESCE(registered_at, CURRENT_TIMESTAMP),
			completed_at = CURRENT_TIMESTAMP, error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.ID); err != nil {
		return err
	}
	if err := finishRemoteFetchWorkflowTx(ctx, tx, manifest, plan, summary, locations, removedCache); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	backupRoot, err := safeDataPath(s.cfg.DataRoot, manifest.BackupRoot)
	if err == nil {
		_ = os.RemoveAll(filepath.Dir(backupRoot))
	}
	return nil
}

// Registration is resumable. Keep remote identities and the rollback backup
// until cleanup/review effects and the terminal workflow result have committed.
func (s *Server) registerRemoteFetchFolder(ctx context.Context, manifest remoteFetchManifestRecord) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_folder_location (
			work_id, file_source_id, root_path, role, origin_source_id,
			origin_remote_code, state, is_primary, last_scanned_at, updated_at
		) VALUES (?, ?, ?, 'managed_fetch', ?, ?, 'active', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(file_source_id, root_path) DO UPDATE SET
			work_id = excluded.work_id,
			role = 'managed_fetch',
			origin_source_id = excluded.origin_source_id,
			origin_remote_code = excluded.origin_remote_code,
			state = 'active',
			cleanup_run_id = NULL,
			is_primary = 1,
			last_scanned_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
	`, manifest.WorkID, manifest.LocalSourceID, manifest.TargetRoot, manifest.RemoteSourceID, manifest.EditionCode); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET source_url = ?, availability = 'available', updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
	`, manifest.TargetRoot, manifest.WorkID, manifest.LocalSourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = CASE WHEN state = 'completed' THEN state ELSE 'registered' END,
			registered_at = COALESCE(registered_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.ID); err != nil {
		return err
	}
	return tx.Commit()
}
