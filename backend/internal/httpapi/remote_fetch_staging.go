package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type remoteFetchManifestRecord struct {
	ID             int64
	WorkflowRunID  int64
	WorkflowJobID  int64
	WorkID         int64
	RemoteSourceID int64
	LocalSourceID  int64
	EditionCode    string
	TargetRoot     string
	StagingRoot    string
	BackupRoot     string
	State          string
	PlanJSON       string
	ErrorMessage   string
}

func createRemoteFetchManifest(ctx context.Context, tx *sql.Tx, runID int64, jobID int64, requestID string, workID int64, remoteSourceID int64, localSourceID int64, plan remoteWorkSavePlan) (int64, error) {
	stagingRoot := filepath.ToSlash(filepath.Join(".kikoto-staging", fmt.Sprintf("%d", runID), "work"))
	backupRoot := filepath.ToSlash(filepath.Join(".kikoto-backup", fmt.Sprintf("%d", runID), "work"))
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO remote_fetch_manifest (
			workflow_run_id, workflow_job_id, request_id, work_id,
			remote_source_id, local_source_id, edition_code,
			target_root, staging_root, backup_root, state, plan_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
	`, runID, jobID, requestID, workID, remoteSourceID, localSourceID, plan.PrimaryCode, plan.SaveRoot, stagingRoot, backupRoot, string(planJSON))
	if err != nil {
		return 0, err
	}
	manifestID, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, item := range plan.Items {
		if item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO remote_fetch_manifest_item (
				manifest_id, relative_path, target_path, source_kind,
				action, expected_size_bytes, remote_source_id, source_path,
				original_target_path, resolution, state
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')
		`, manifestID, relativePath, item.TargetPath, item.SourceKind, item.Action, item.SizeBytes,
			nullablePositiveInt64(item.RemoteSourceID), item.SourcePath, item.OriginalTargetPath, item.Resolution); err != nil {
			return 0, err
		}
	}
	return manifestID, nil
}

func fetchPathRelativeToRoot(root string, target string) (string, error) {
	root = filepath.Clean(filepath.FromSlash(root))
	target = filepath.Clean(filepath.FromSlash(target))
	relative, err := filepath.Rel(root, target)
	if err != nil {
		return "", err
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("fetch target %q is outside root %q", target, root)
	}
	return filepath.ToSlash(relative), nil
}

func (s *Server) loadRemoteFetchManifest(ctx context.Context, runID int64) (remoteFetchManifestRecord, error) {
	var item remoteFetchManifestRecord
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workflow_run_id, COALESCE(workflow_job_id, 0), work_id,
			remote_source_id, local_source_id, edition_code, target_root,
			staging_root, backup_root, state, plan_json, error_message
		FROM remote_fetch_manifest
		WHERE workflow_run_id = ?
	`, runID).Scan(&item.ID, &item.WorkflowRunID, &item.WorkflowJobID, &item.WorkID, &item.RemoteSourceID, &item.LocalSourceID, &item.EditionCode, &item.TargetRoot, &item.StagingRoot, &item.BackupRoot, &item.State, &item.PlanJSON, &item.ErrorMessage)
	return item, err
}

func (s *Server) refreshRemoteFetchManifestPlan(ctx context.Context, manifestID int64, plan remoteWorkSavePlan) error {
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET edition_code = ?, target_root = ?, state = 'planned', plan_json = ?, error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, plan.PrimaryCode, plan.SaveRoot, string(planJSON), manifestID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM remote_fetch_manifest_item WHERE manifest_id = ?", manifestID); err != nil {
		return err
	}
	for _, item := range plan.Items {
		if item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO remote_fetch_manifest_item (
				manifest_id, relative_path, target_path, source_kind, action,
				expected_size_bytes, remote_source_id, source_path,
				original_target_path, resolution, state
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')
		`, manifestID, relativePath, item.TargetPath, item.SourceKind, item.Action, item.SizeBytes,
			nullablePositiveInt64(item.RemoteSourceID), item.SourcePath, item.OriginalTargetPath, item.Resolution); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) stageAndPublishRemoteFetch(ctx context.Context, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan) (int, error) {
	stageRoot, err := safeDataPath(s.cfg.DataRoot, manifest.StagingRoot)
	if err != nil {
		return 0, err
	}
	targetRoot, err := safeDataPath(s.cfg.DataRoot, manifest.TargetRoot)
	if err != nil {
		return 0, err
	}
	backupRoot, err := safeDataPath(s.cfg.DataRoot, manifest.BackupRoot)
	if err != nil {
		return 0, err
	}
	if manifest.State == "published" || manifest.State == "registered" || manifest.State == "completed" {
		return countPromotedFetchItems(plan.Items), nil
	}
	if countPromotedFetchItems(plan.Items) == 0 {
		for _, nodeID := range []string{"stage", "verify", "promote"} {
			_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, nodeID, "succeeded", map[string]any{"unchanged": true})
		}
		if _, err := s.db.ExecContext(ctx, `
			UPDATE remote_fetch_manifest
			SET state = 'published', error_message = '', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, manifest.ID); err != nil {
			return 0, err
		}
		return 0, nil
	}
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "stage", "running", nil)
	if manifest.State == "planned" {
		if err := os.RemoveAll(stageRoot); err != nil && !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
		if info, err := os.Stat(targetRoot); err == nil && info.IsDir() {
			if err := copyDirectoryTree(targetRoot, stageRoot); err != nil {
				return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
		} else if errors.Is(err, os.ErrNotExist) {
			if err := os.MkdirAll(stageRoot, 0o755); err != nil {
				return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
		} else if err != nil {
			return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		if err := s.updateRemoteFetchManifestState(ctx, manifest.ID, "staging", ""); err != nil {
			return 0, err
		}
		manifest.State = "staging"
	}

	for _, item := range plan.Items {
		if item.Action == "skip" || item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		stagedPath := filepath.Join(stageRoot, filepath.FromSlash(relativePath))
		if !existingFileMatches(stagedPath, item.SizeBytes) {
			if err := os.MkdirAll(filepath.Dir(stagedPath), 0o755); err != nil {
				return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
			var sourcePath string
			if item.Action == "copy_local" {
				sourcePath, err = safeDataPath(s.cfg.DataRoot, item.LocalSourcePath)
			} else {
				sourcePath, err = safeCachePath(s.cfg.CacheRoot, item.CachePath)
			}
			if err != nil {
				return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
			if err := copyFile(sourcePath, stagedPath); err != nil {
				return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
		}
		if _, err := s.db.ExecContext(ctx, `
			UPDATE remote_fetch_manifest_item
			SET state = 'staged', error_message = '', updated_at = CURRENT_TIMESTAMP
			WHERE manifest_id = ? AND target_path = ?
		`, manifest.ID, item.TargetPath); err != nil {
			return 0, err
		}
	}
	if err := s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "stage", "succeeded", map[string]any{"staged": countPromotedFetchItems(plan.Items)}); err != nil {
		return 0, err
	}
	if err := s.updateRemoteFetchManifestState(ctx, manifest.ID, "staged", ""); err != nil {
		return 0, err
	}
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "verify", "running", nil)
	for _, item := range plan.Items {
		if item.Action == "skip" || item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		stagedPath := filepath.Join(stageRoot, filepath.FromSlash(relativePath))
		hash, size, err := hashFile(stagedPath)
		if err != nil {
			return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		if item.SizeBytes != nil && size != *item.SizeBytes {
			err := fmt.Errorf("staged size mismatch for %s: got %d, want %d", relativePath, size, *item.SizeBytes)
			return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		if _, err := s.db.ExecContext(ctx, `
			UPDATE remote_fetch_manifest_item
			SET state = 'verified', content_hash = ?, error_message = '', updated_at = CURRENT_TIMESTAMP
			WHERE manifest_id = ? AND target_path = ?
		`, hash, manifest.ID, item.TargetPath); err != nil {
			return 0, err
		}
	}
	if err := s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "verify", "succeeded", map[string]any{"verified": countPromotedFetchItems(plan.Items)}); err != nil {
		return 0, err
	}
	if err := s.updateRemoteFetchManifestState(ctx, manifest.ID, "verified", ""); err != nil {
		return 0, err
	}
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "promote", "running", nil)
	if err := s.updateRemoteFetchManifestState(ctx, manifest.ID, "publishing", ""); err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(backupRoot), 0o755); err != nil {
		return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	_ = os.RemoveAll(backupRoot)
	targetExisted := false
	if _, err := os.Stat(targetRoot); err == nil {
		targetExisted = true
		if err := os.Rename(targetRoot, backupRoot); err != nil {
			return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, fmt.Errorf("backup current fetch root: %w", err))
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := os.MkdirAll(filepath.Dir(targetRoot), 0o755); err != nil {
		if targetExisted {
			_ = os.Rename(backupRoot, targetRoot)
		}
		return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := os.Rename(stageRoot, targetRoot); err != nil {
		if targetExisted {
			_ = os.Rename(backupRoot, targetRoot)
		}
		return 0, s.recordRemoteFetchManifestError(ctx, manifest.ID, fmt.Errorf("publish staged fetch root: %w", err))
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = 'published', error_message = '', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.ID); err != nil {
		return 0, err
	}
	return countPromotedFetchItems(plan.Items), nil
}

func (s *Server) completeRemoteFetchManifest(ctx context.Context, manifest remoteFetchManifestRecord) error {
	tx, err := s.db.BeginTx(ctx, nil)
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
		SET state = 'completed', registered_at = COALESCE(registered_at, CURRENT_TIMESTAMP),
			completed_at = CURRENT_TIMESTAMP, error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.ID); err != nil {
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

func (s *Server) updateRemoteFetchManifestState(ctx context.Context, manifestID int64, state string, message string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE remote_fetch_manifest SET state = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`, state, message, manifestID)
	return err
}

func (s *Server) updateRemoteFetchPhaseNode(ctx context.Context, runID int64, nodeID string, status string, output map[string]any) error {
	var exists bool
	if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = ?)", runID, nodeID).Scan(&exists); err != nil || !exists {
		return err
	}
	outputJSON := "{}"
	if output != nil {
		outputJSON = mustJSON(output)
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?, output_json = ?, error_message = '',
			started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
			finished_at = CASE WHEN ? IN ('succeeded', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END
		WHERE workflow_run_id = ? AND node_id = ?
	`, status, outputJSON, status, status, runID, nodeID)
	return err
}

func (s *Server) recordRemoteFetchManifestError(ctx context.Context, manifestID int64, runErr error) error {
	_, _ = s.db.ExecContext(ctx, `
		UPDATE remote_fetch_manifest SET error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`, runErr.Error(), manifestID)
	return runErr
}

func countPromotedFetchItems(items []remoteWorkSavePlanItem) int {
	count := 0
	for _, item := range items {
		if item.Action != "skip" && item.Action != "exclude" {
			count++
		}
	}
	return count
}

func hashFile(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(hash.Sum(nil)), size, nil
}

func copyDirectoryTree(sourceRoot string, targetRoot string) error {
	return filepath.WalkDir(sourceRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(sourceRoot, path)
		if err != nil {
			return err
		}
		target := filepath.Join(targetRoot, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("fetch root contains unsupported symbolic link: %s", filepath.ToSlash(relative))
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return copyFile(path, target)
	})
}

func (s *Server) reconcileRemoteFetchManifests(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT manifest.workflow_run_id, run.status
		FROM remote_fetch_manifest AS manifest
		INNER JOIN workflow_run AS run ON run.id = manifest.workflow_run_id
		WHERE manifest.state <> 'completed'
		ORDER BY manifest.id ASC
	`)
	if err != nil {
		return err
	}
	type pendingManifest struct {
		runID     int64
		runStatus string
	}
	pending := []pendingManifest{}
	for rows.Next() {
		var item pendingManifest
		if err := rows.Scan(&item.runID, &item.runStatus); err != nil {
			_ = rows.Close()
			return err
		}
		pending = append(pending, item)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, item := range pending {
		manifest, err := s.loadRemoteFetchManifest(ctx, item.runID)
		if err != nil {
			return err
		}
		switch manifest.State {
		case "published", "registered":
			if err := s.registerPublishedRemoteFetch(ctx, manifest); err != nil {
				return err
			}
		case "publishing":
			if err := s.reconcilePublishingRemoteFetch(ctx, manifest); err != nil {
				return err
			}
			refreshed, err := s.loadRemoteFetchManifest(ctx, item.runID)
			if err != nil {
				return err
			}
			if refreshed.State == "published" {
				if err := s.registerPublishedRemoteFetch(ctx, refreshed); err != nil {
					return err
				}
			} else if workflowRunCanResume(item.runStatus) {
				if err := s.requeueRemoteFetchManifest(ctx, refreshed); err != nil {
					return err
				}
			}
		default:
			if !workflowRunCanResume(item.runStatus) {
				continue
			}
			if err := s.requeueRemoteFetchManifest(ctx, manifest); err != nil {
				return err
			}
		}
	}
	return nil
}

func workflowRunCanResume(status string) bool {
	return status == "queued" || status == "running"
}

func (s *Server) reconcilePublishingRemoteFetch(ctx context.Context, manifest remoteFetchManifestRecord) error {
	targetRoot, err := safeDataPath(s.cfg.DataRoot, manifest.TargetRoot)
	if err != nil {
		return err
	}
	stageRoot, err := safeDataPath(s.cfg.DataRoot, manifest.StagingRoot)
	if err != nil {
		return err
	}
	backupRoot, err := safeDataPath(s.cfg.DataRoot, manifest.BackupRoot)
	if err != nil {
		return err
	}
	targetExists := pathExists(targetRoot)
	stageExists := pathExists(stageRoot)
	backupExists := pathExists(backupRoot)
	switch {
	case targetExists && !stageExists:
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'published', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	case !targetExists && stageExists:
		if err := os.MkdirAll(filepath.Dir(targetRoot), 0o755); err != nil {
			return err
		}
		if err := os.Rename(stageRoot, targetRoot); err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'published', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	case !targetExists && !stageExists && backupExists:
		if err := os.Rename(backupRoot, targetRoot); err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'planned', error_message = 'publication rolled back during startup recovery', updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	default:
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	}
}

func (s *Server) registerPublishedRemoteFetch(ctx context.Context, manifest remoteFetchManifestRecord) error {
	var plan remoteWorkSavePlan
	if err := json.Unmarshal([]byte(manifest.PlanJSON), &plan); err != nil {
		return err
	}
	for _, item := range plan.Items {
		if item.Action == "exclude" {
			continue
		}
		targetPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			return err
		}
		if _, err := os.Stat(targetPath); err != nil {
			return err
		}
		if err := s.upsertSavedLocalLocation(ctx, manifest.WorkID, manifest.LocalSourceID, item, targetPath); err != nil {
			return err
		}
	}
	if err := s.finishFetchPresence(ctx, manifest.WorkID, remoteFetchPlanSourceIDs(plan, manifest.RemoteSourceID), manifest.LocalSourceID, manifest.EditionCode); err != nil {
		return err
	}
	if err := s.completeRemoteFetchManifest(ctx, manifest); err != nil {
		return err
	}
	summary := mustJSON(map[string]any{"recovered": true, "published": countPromotedFetchItems(plan.Items), "plan": plan.Summary})
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE workflow_run_id = ? AND node_id IN ('stage', 'verify', 'promote', 'sync')", summary, manifest.WorkflowRunID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_job SET status = 'succeeded', error_message = '', locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.WorkflowJobID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", summary, manifest.WorkflowRunID)
	return err
}

func nullablePositiveInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func (s *Server) requeueRemoteFetchManifest(ctx context.Context, manifest remoteFetchManifestRecord) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = 'queued', finished_at = NULL, summary_json = json_set(COALESCE(NULLIF(summary_json, ''), '{}'), '$.recovered', true) WHERE id = ?", manifest.WorkflowRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = CASE WHEN node_id IN ('select', 'tree', 'plan') THEN 'succeeded' ELSE 'queued' END,
			error_message = '', finished_at = CASE WHEN node_id IN ('select', 'tree', 'plan') THEN finished_at ELSE NULL END
		WHERE workflow_run_id = ?
	`, manifest.WorkflowRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'queued', error_message = '', locked_by = '', locked_at = NULL,
			heartbeat_at = NULL, retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.WorkflowJobID); err != nil {
		return err
	}
	return tx.Commit()
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
