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
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
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
	paths, err := s.remoteFetchPublishPaths(manifest)
	if err != nil {
		return 0, err
	}
	manifest, err = s.settleInterruptedRemoteFetchPublication(ctx, manifest)
	if err != nil {
		return 0, err
	}
	if manifest.State == "published" || manifest.State == "registered" || manifest.State == "completed" {
		return countPromotedFetchItems(plan.Items), nil
	}
	if countPromotedFetchItems(plan.Items) == 0 {
		return 0, s.markUnchangedRemoteFetchPublished(ctx, manifest)
	}
	if err := s.stageRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
		return 0, err
	}
	if err := s.verifyRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
		return 0, err
	}
	if err := s.publishRemoteFetchRoot(ctx, manifest, paths); err != nil {
		return 0, err
	}
	return countPromotedFetchItems(plan.Items), nil
}

const remoteFetchPublishTimeout = 10 * time.Second

var errRemoteFetchBackupPending = errors.New("a previous Fetch publication backup still needs review before publishing again")

type remoteFetchPublishPaths struct {
	stageRoot  string
	targetRoot string
	backupRoot string
}

func (s *Server) remoteFetchPublishPaths(manifest remoteFetchManifestRecord) (remoteFetchPublishPaths, error) {
	stageRoot, err := safeDataPath(s.cfg.DataRoot, manifest.StagingRoot)
	if err != nil {
		return remoteFetchPublishPaths{}, err
	}
	targetRoot, err := safeDataPath(s.cfg.DataRoot, manifest.TargetRoot)
	if err != nil {
		return remoteFetchPublishPaths{}, err
	}
	backupRoot, err := safeDataPath(s.cfg.DataRoot, manifest.BackupRoot)
	if err != nil {
		return remoteFetchPublishPaths{}, err
	}
	return remoteFetchPublishPaths{stageRoot: stageRoot, targetRoot: targetRoot, backupRoot: backupRoot}, nil
}

func (s *Server) markUnchangedRemoteFetchPublished(ctx context.Context, manifest remoteFetchManifestRecord) error {
	for _, nodeID := range []string{"stage", "verify", "promote"} {
		_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, nodeID, "succeeded", map[string]any{"unchanged": true})
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = 'published', error_message = '', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.ID)
	return err
}

func (s *Server) stageRemoteFetchItems(ctx context.Context, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan, paths remoteFetchPublishPaths) error {
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "stage", "running", nil)
	if manifest.State == "planned" {
		if err := s.initializeRemoteFetchStaging(ctx, manifest, paths); err != nil {
			return err
		}
	}
	for _, item := range plan.Items {
		if item.Action == "skip" || item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		stagedPath := filepath.Join(paths.stageRoot, filepath.FromSlash(relativePath))
		reusable, err := s.verifiedRemoteFetchItemMatches(ctx, manifest.ID, item, stagedPath)
		if err != nil {
			return err
		}
		if !reusable {
			if err := os.MkdirAll(filepath.Dir(stagedPath), 0o755); err != nil {
				return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
			sourcePath, err := s.remoteFetchSourcePath(item)
			if err != nil {
				return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
			if err := copyFile(sourcePath, stagedPath); err != nil {
				return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
		}
		if _, err := s.db.ExecContext(ctx, `
			UPDATE remote_fetch_manifest_item
			SET state = 'staged', error_message = '', updated_at = CURRENT_TIMESTAMP
			WHERE manifest_id = ? AND target_path = ?
		`, manifest.ID, item.TargetPath); err != nil {
			return err
		}
	}
	if err := s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "stage", "succeeded", map[string]any{"staged": countPromotedFetchItems(plan.Items)}); err != nil {
		return err
	}
	return s.updateRemoteFetchManifestState(ctx, manifest.ID, "staged", "")
}

// A file copied from the old target is not a completed staging operation.
// Only a prior verified manifest entry can authorize reuse after interruption.
func (s *Server) verifiedRemoteFetchItemMatches(ctx context.Context, manifestID int64, item remoteWorkSavePlanItem, stagedPath string) (bool, error) {
	var expectedHash string
	err := s.db.QueryRowContext(ctx, `
		SELECT content_hash FROM remote_fetch_manifest_item
		WHERE manifest_id = ? AND target_path = ? AND state = 'verified'
	`, manifestID, item.TargetPath).Scan(&expectedHash)
	if errors.Is(err, sql.ErrNoRows) || expectedHash == "" && err == nil {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !existingFileMatches(stagedPath, item.SizeBytes) {
		return false, nil
	}
	actualHash, _, err := hashFile(stagedPath)
	return actualHash == expectedHash && err == nil, err
}

func (s *Server) initializeRemoteFetchStaging(ctx context.Context, manifest remoteFetchManifestRecord, paths remoteFetchPublishPaths) error {
	if err := os.RemoveAll(paths.stageRoot); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if info, err := os.Stat(paths.targetRoot); err == nil && info.IsDir() {
		if err := copyDirectoryTree(paths.targetRoot, paths.stageRoot); err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(paths.stageRoot, 0o755); err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
	} else if err != nil {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	return s.updateRemoteFetchManifestState(ctx, manifest.ID, "staging", "")
}

func (s *Server) remoteFetchSourcePath(item remoteWorkSavePlanItem) (string, error) {
	if item.Action == "copy_local" {
		return safeDataPath(s.cfg.DataRoot, item.LocalSourcePath)
	}
	return safeCachePath(s.cfg.CacheRoot, item.CachePath)
}

func (s *Server) verifyRemoteFetchItems(ctx context.Context, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan, paths remoteFetchPublishPaths) error {
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "verify", "running", nil)
	for _, item := range plan.Items {
		if item.Action == "skip" || item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		hash, size, err := hashFile(filepath.Join(paths.stageRoot, filepath.FromSlash(relativePath)))
		if err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		if item.SizeBytes != nil && size != *item.SizeBytes {
			err := fmt.Errorf("staged size mismatch for %s: got %d, want %d", relativePath, size, *item.SizeBytes)
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		if _, err := s.db.ExecContext(ctx, `
			UPDATE remote_fetch_manifest_item
			SET state = 'verified', content_hash = ?, error_message = '', updated_at = CURRENT_TIMESTAMP
			WHERE manifest_id = ? AND target_path = ?
		`, hash, manifest.ID, item.TargetPath); err != nil {
			return err
		}
	}
	if err := s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "verify", "succeeded", map[string]any{"verified": countPromotedFetchItems(plan.Items)}); err != nil {
		return err
	}
	return s.updateRemoteFetchManifestState(ctx, manifest.ID, "verified", "")
}

func (s *Server) publishRemoteFetchRoot(ctx context.Context, manifest remoteFetchManifestRecord, paths remoteFetchPublishPaths) error {
	// Publication swaps directories and then records the result. Cancellation
	// may prevent it from starting, but once started it must record where the
	// roots are, so a service stop cannot leave a finished swap marked as still
	// publishing.
	if err := ctx.Err(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), remoteFetchPublishTimeout)
	defer cancel()
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "promote", "running", nil)
	// Once a publication rename has happened, the backup is the only copy of
	// the previous root. Never replace it; recovery must settle it first.
	if _, err := os.Lstat(paths.backupRoot); err == nil {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, errRemoteFetchBackupPending)
	} else if !errors.Is(err, os.ErrNotExist) {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := s.updateRemoteFetchManifestState(ctx, manifest.ID, "publishing", ""); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(paths.backupRoot), 0o755); err != nil {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	targetExisted := false
	if _, err := os.Stat(paths.targetRoot); err == nil {
		targetExisted = true
		if err := os.Rename(paths.targetRoot, paths.backupRoot); err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, fmt.Errorf("backup current fetch root: %w", err))
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := os.MkdirAll(filepath.Dir(paths.targetRoot), 0o755); err != nil {
		if targetExisted {
			_ = os.Rename(paths.backupRoot, paths.targetRoot)
		}
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := os.Rename(paths.stageRoot, paths.targetRoot); err != nil {
		if targetExisted {
			_ = os.Rename(paths.backupRoot, paths.targetRoot)
		}
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, fmt.Errorf("publish staged fetch root: %w", err))
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = 'published', error_message = '', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.ID)
	return err
}

// Completion retires the remote_stream rows in the same transaction that marks
// the manifest completed. Registration resolves media items through those rows,
// so removing them earlier would leave an interrupted Fetch unrecoverable.
func (s *Server) completeRemoteFetchManifest(ctx context.Context, manifest remoteFetchManifestRecord, remoteSourceIDs []int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := retireFetchRemoteStreams(ctx, tx, manifest.WorkID, remoteSourceIDs); err != nil {
		return err
	}
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
	s.execBestEffort(ctx, "record remote fetch manifest error", `
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
		if err := s.reconcileRemoteFetchManifest(ctx, item.runID, item.runStatus); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// One unrecoverable Fetch must not keep the server from starting.
			slog.Error("recover interrupted remote Fetch", "run_id", item.runID, "error", err)
			if err := recordRemoteFetchRecoveryFailure(ctx, s.db, item.runID); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) reconcileRemoteFetchManifest(ctx context.Context, runID int64, runStatus string) error {
	manifest, err := s.loadRemoteFetchManifest(ctx, runID)
	if err != nil {
		return err
	}
	switch manifest.State {
	case "published", "registered":
		return s.registerPublishedRemoteFetch(ctx, manifest)
	case "publishing":
		refreshed, err := s.settleInterruptedRemoteFetchPublication(ctx, manifest)
		if err != nil {
			return err
		}
		if refreshed.State == "published" {
			return s.registerPublishedRemoteFetch(ctx, refreshed)
		}
		if workflowRunCanResume(runStatus) {
			return s.requeueRemoteFetchManifest(ctx, refreshed)
		}
		return nil
	default:
		if !workflowRunCanResume(runStatus) {
			return nil
		}
		return s.requeueRemoteFetchManifest(ctx, manifest)
	}
}

// The detailed cause stays in the server log; Activity only records that the
// Fetch needs attention, because the cause can include local paths.
func recordRemoteFetchRecoveryFailure(ctx context.Context, db *sql.DB, runID int64) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		Level:   "error",
		Type:    "fetch.recovery_failed",
		Message: "Startup recovery could not finish this Fetch; see the server log for details",
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func workflowRunCanResume(status string) bool {
	return status == "queued" || status == "running"
}

// A publication interrupted after its renames leaves the staging root already
// promoted. Settle the manifest from filesystem evidence before any retry
// stages again, or the retry would publish only the newly selected files.
func (s *Server) settleInterruptedRemoteFetchPublication(ctx context.Context, manifest remoteFetchManifestRecord) (remoteFetchManifestRecord, error) {
	if manifest.State != "publishing" {
		return manifest, nil
	}
	if err := s.reconcilePublishingRemoteFetch(ctx, manifest); err != nil {
		return manifest, err
	}
	return s.loadRemoteFetchManifest(ctx, manifest.WorkflowRunID)
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
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'published', error_message = '', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	case !targetExists && stageExists:
		if err := os.MkdirAll(filepath.Dir(targetRoot), 0o755); err != nil {
			return err
		}
		if err := os.Rename(stageRoot, targetRoot); err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'published', error_message = '', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	case !targetExists && !stageExists && backupExists:
		if err := os.Rename(backupRoot, targetRoot); err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'planned', error_message = 'publication rolled back during recovery', updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
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
	remoteSourceIDs := remoteFetchPlanSourceIDs(plan, manifest.RemoteSourceID)
	if err := s.finishFetchPresence(ctx, manifest.WorkID, remoteSourceIDs, manifest.LocalSourceID, manifest.EditionCode); err != nil {
		return err
	}
	removedCache, err := s.cleanupPromotedFetchCache(ctx, plan, manifest.WorkID)
	if err != nil {
		return err
	}
	if err := s.completeRemoteFetchManifest(ctx, manifest, remoteSourceIDs); err != nil {
		return err
	}
	summary := mustJSON(map[string]any{"recovered": true, "published": countPromotedFetchItems(plan.Items), "cache_removed": removedCache, "plan": plan.Summary})
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE workflow_run_id = ? AND node_id IN ('stage', 'verify', 'promote', 'sync', 'cleanup')", summary, manifest.WorkflowRunID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_job SET status = 'succeeded', error_message = '', locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.WorkflowJobID); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", summary, manifest.WorkflowRunID)
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
