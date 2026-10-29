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

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storagepool"
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
	// Staging and backup live on the target's pool so publication and
	// rollback are same-filesystem renames.
	stagingRoot := storagepool.Join(plan.TransactionPool, filepath.ToSlash(filepath.Join(".kikoto-staging", fmt.Sprintf("%d", runID), "work")))
	backupRoot := storagepool.Join(plan.TransactionPool, filepath.ToSlash(filepath.Join(".kikoto-backup", fmt.Sprintf("%d", runID), "work")))
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
	// The plan checked the pool, but the run may start or resume after the
	// pool went offline; writing then would fill its empty mount point.
	if err := s.ensureLibraryPathOnline(ctx, manifest.TargetRoot); err != nil {
		return 0, err
	}
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
	root, scoped, err := s.openRemoteFetchPublishPaths(paths)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := walkFetchDirectory(root, scoped.stageRoot, nil); err != nil {
		return err
	}
	sources := distinctFetchFiles{}
	for _, item := range plan.Items {
		if item.Action == "skip" || item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		stagedPath := filepath.Join(scoped.stageRoot, filepath.FromSlash(relativePath))
		reusable, err := s.verifiedRemoteFetchItemMatches(ctx, manifest.ID, item, root, stagedPath)
		if err != nil {
			return err
		}
		if !reusable {
			source, err := s.openRemoteFetchSource(item)
			if err != nil {
				return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
			}
			info, err := source.Stat()
			if err != nil || !info.Mode().IsRegular() {
				_ = source.Close()
				return s.recordRemoteFetchManifestError(ctx, manifest.ID, errors.New("fetch source is not a regular file"))
			}
			// Two downloads that the cache stores as one file would publish the
			// same bytes under both names.
			if item.Action != "copy_local" {
				if other := sources.claim(info, relativePath); other != "" {
					_ = source.Close()
					err := fmt.Errorf("downloads for %s and %s are one file in the cache; fetch them one at a time", other, relativePath)
					return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
				}
			}
			copyErr := copyFetchFile(root, stagedPath, fetchStagingCopyTempPath(scoped.stageRoot), source)
			closeErr := source.Close()
			if err := errors.Join(copyErr, closeErr); err != nil {
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
func (s *Server) verifiedRemoteFetchItemMatches(ctx context.Context, manifestID int64, item remoteWorkSavePlanItem, root *os.Root, stagedPath string) (bool, error) {
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
	info, err := root.Stat(stagedPath)
	if err != nil || !info.Mode().IsRegular() || item.SizeBytes != nil && info.Size() != *item.SizeBytes {
		return false, nil
	}
	actualHash, _, err := hashFetchFile(root, stagedPath)
	return actualHash == expectedHash && err == nil, err
}

func (s *Server) initializeRemoteFetchStaging(ctx context.Context, manifest remoteFetchManifestRecord, paths remoteFetchPublishPaths) error {
	root, scoped, err := s.openRemoteFetchPublishPaths(paths)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := removeFetchDirectory(root, scoped.stageRoot); err != nil {
		return err
	}
	if info, err := root.Stat(scoped.targetRoot); err == nil && info.IsDir() {
		if err := copyFetchDirectory(root, scoped.targetRoot, scoped.stageRoot); err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if err := root.MkdirAll(scoped.stageRoot, 0o755); err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
	} else if err != nil {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	return s.updateRemoteFetchManifestState(ctx, manifest.ID, "staging", "")
}

func (s *Server) verifyRemoteFetchItems(ctx context.Context, manifest remoteFetchManifestRecord, plan remoteWorkSavePlan, paths remoteFetchPublishPaths) error {
	root, scoped, err := s.openRemoteFetchPublishPaths(paths)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := walkFetchDirectory(root, scoped.stageRoot, nil); err != nil {
		return err
	}
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "verify", "running", nil)
	staged := distinctFetchFiles{}
	for _, item := range plan.Items {
		if item.Action == "skip" || item.Action == "exclude" {
			continue
		}
		relativePath, err := fetchPathRelativeToRoot(plan.SaveRoot, item.TargetPath)
		if err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		stagedPath := filepath.Join(scoped.stageRoot, filepath.FromSlash(relativePath))
		info, err := root.Stat(stagedPath)
		if err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		if other := staged.claim(info, relativePath); other != "" {
			err := fmt.Errorf("staged files %s and %s are one file on this filesystem; the Fetch would publish fewer files than planned", other, relativePath)
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
		}
		hash, size, err := hashFetchFile(root, stagedPath)
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

// distinctFetchFiles checks that every planned file is its own file on disk.
// Two planned paths that a filesystem stores as one file would otherwise each
// verify against the same bytes and publish one file short.
type distinctFetchFiles map[int64][]distinctFetchFile

type distinctFetchFile struct {
	info         os.FileInfo
	relativePath string
}

// claim records the file described by info for relativePath. It returns the relative
// path that already claimed the same file, or "" when the file is new.
func (files distinctFetchFiles) claim(info os.FileInfo, relativePath string) string {
	// The same file has one size, so only same-sized files need comparing.
	for _, other := range files[info.Size()] {
		if os.SameFile(info, other.info) {
			return other.relativePath
		}
	}
	files[info.Size()] = append(files[info.Size()], distinctFetchFile{info: info, relativePath: relativePath})
	return ""
}

func (s *Server) publishRemoteFetchRoot(ctx context.Context, manifest remoteFetchManifestRecord, paths remoteFetchPublishPaths) error {
	// Publication swaps directories and then records the result. Cancellation
	// may prevent it from starting, but once started it must record where the
	// roots are, so a service stop cannot leave a finished swap marked as still
	// publishing. No custom work renames a folder while the swap places the
	// target root; a scan or cleanup may hold the lock for a long time, so the
	// wait stays cancellable and the time limit covers only the swap.
	if err := s.mediaCleanupMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.mediaCleanupMu.Unlock()
	root, scoped, err := s.openRemoteFetchPublishPaths(paths)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	if err := walkFetchDirectory(root, scoped.stageRoot, nil); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), remoteFetchPublishTimeout)
	defer cancel()
	_ = s.updateRemoteFetchPhaseNode(ctx, manifest.WorkflowRunID, "promote", "running", nil)
	// Once a publication rename has happened, the backup is the only copy of
	// the previous root. Never replace it; recovery must settle it first.
	if _, err := root.Lstat(scoped.backupRoot); err == nil {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, errRemoteFetchBackupPending)
	} else if !errors.Is(err, os.ErrNotExist) {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := s.updateRemoteFetchManifestState(ctx, manifest.ID, "publishing", ""); err != nil {
		return err
	}
	if err := root.MkdirAll(filepath.Dir(scoped.backupRoot), 0o755); err != nil {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	targetExisted := false
	if _, err := root.Stat(scoped.targetRoot); err == nil {
		targetExisted = true
		if err := root.Rename(scoped.targetRoot, scoped.backupRoot); err != nil {
			return s.recordRemoteFetchManifestError(ctx, manifest.ID, fmt.Errorf("backup current fetch root: %w", err))
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := root.MkdirAll(filepath.Dir(scoped.targetRoot), 0o755); err != nil {
		if targetExisted {
			_ = root.Rename(scoped.backupRoot, scoped.targetRoot)
		}
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, err)
	}
	if err := root.Rename(scoped.stageRoot, scoped.targetRoot); err != nil {
		if targetExisted {
			_ = root.Rename(scoped.backupRoot, scoped.targetRoot)
		}
		return s.recordRemoteFetchManifestError(ctx, manifest.ID, fmt.Errorf("publish staged fetch root: %w", err))
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = 'published', error_message = '', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, manifest.ID)
	return err
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
			OR run.status <> 'succeeded'
			OR EXISTS (SELECT 1 FROM workflow_job AS job WHERE job.id = manifest.workflow_job_id AND job.status <> 'succeeded')
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
			// On an offline pool every root looks absent. The manifest keeps its
			// state until the pool is back and the run is retried.
			if errors.Is(err, errStoragePoolOffline) || errors.Is(err, errLibraryOffline) {
				slog.Warn("interrupted remote Fetch waits for its storage pool", "run_id", item.runID)
				continue
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
	if _, resumed, err := s.resumeRemoteFetchPublication(ctx, manifest); resumed || err != nil {
		return err
	}
	if !workflowRunCanResume(runStatus) {
		return nil
	}
	return s.requeueRemoteFetchManifest(ctx, manifest)
}

// The detailed cause stays in the server log; Activity only records that the
// Fetch needs attention, because the cause can include local paths.
func recordRemoteFetchRecoveryFailure(ctx context.Context, db *sqlutil.DB, runID int64) error {
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
	// The evidence is read from the target's pool. While it is offline its
	// mount point shows none of the roots, which is not evidence of anything.
	if err := s.ensureLibraryPathOnline(ctx, manifest.TargetRoot); err != nil {
		return manifest, err
	}
	if err := s.reconcilePublishingRemoteFetch(ctx, manifest); err != nil {
		return manifest, err
	}
	return s.loadRemoteFetchManifest(ctx, manifest.WorkflowRunID)
}

func (s *Server) reconcilePublishingRemoteFetch(ctx context.Context, manifest remoteFetchManifestRecord) error {
	paths, err := s.remoteFetchPublishPaths(manifest)
	if err != nil {
		return err
	}
	root, scoped, err := s.openRemoteFetchPublishPaths(paths)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	// Opening the paths refused a root, or a folder above one, that is a link
	// or not a directory. Which roots exist decides the outcome; what they hold
	// does not, and a rename moves a directory without following links inside
	// it, so a link or special file the user keeps in the target cannot stall
	// recovery.
	exists := make(map[string]bool, 3)
	for _, name := range []string{scoped.targetRoot, scoped.stageRoot, scoped.backupRoot} {
		_, err := root.Lstat(name)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		exists[name] = err == nil
	}
	targetExists, stageExists, backupExists := exists[scoped.targetRoot], exists[scoped.stageRoot], exists[scoped.backupRoot]
	switch {
	case targetExists && !stageExists:
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'published', error_message = '', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	case !targetExists && stageExists:
		if err := root.MkdirAll(filepath.Dir(scoped.targetRoot), 0o755); err != nil {
			return err
		}
		if err := root.Rename(scoped.stageRoot, scoped.targetRoot); err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'published', error_message = '', published_at = COALESCE(published_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	case !targetExists && !stageExists && backupExists:
		if err := root.Rename(scoped.backupRoot, scoped.targetRoot); err != nil {
			return err
		}
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'planned', error_message = 'publication rolled back during recovery', updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	default:
		_, err = s.db.ExecContext(ctx, "UPDATE remote_fetch_manifest SET state = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = ?", manifest.ID)
		return err
	}
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
