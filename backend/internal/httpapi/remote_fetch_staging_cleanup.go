package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	defaultFetchStagingRetentionDays = 7
	minimumFetchStagingRetentionDays = 1
	maximumFetchStagingRetentionDays = 365
	remoteFetchStagingCleanupPeriod  = 6 * time.Hour
)

type remoteFetchStagingCleanupResult struct {
	Cleaned int
	Blocked int
	Files   int64
	Bytes   int64
}

type fetchStagingCleanupCandidate struct {
	ManifestID int64
	RunID      int64
	State      string
}

type removedFetchStaging struct {
	Files int64
	Bytes int64
}

func (s *Server) configuredFetchStagingRetentionDays(ctx context.Context) int {
	days := s.settingIntContext(ctx, "fetch_staging_retention_days", defaultFetchStagingRetentionDays)
	if days < minimumFetchStagingRetentionDays || days > maximumFetchStagingRetentionDays {
		return defaultFetchStagingRetentionDays
	}
	return days
}

func (s *Server) cleanupExpiredRemoteFetchStaging(ctx context.Context, now time.Time) (remoteFetchStagingCleanupResult, error) {
	// Kikoto currently runs one application instance. Serialize startup,
	// scheduled, and test/manual reconciliation so a recovered
	// cleaning_staging claim cannot be processed twice inside that instance.
	s.fetchStagingCleanupMu.Lock()
	defer s.fetchStagingCleanupMu.Unlock()

	retentionDays := s.configuredFetchStagingRetentionDays(ctx)
	cutoff := now.UTC().Add(-time.Duration(retentionDays) * 24 * time.Hour).Format("2006-01-02 15:04:05")
	rows, err := s.db.QueryContext(ctx, `
		SELECT manifest.id, manifest.workflow_run_id, manifest.state
		FROM remote_fetch_manifest AS manifest
		INNER JOIN workflow_run AS run ON run.id = manifest.workflow_run_id
		WHERE manifest.staging_cleaned_at IS NULL
			AND manifest.state IN ('planned', 'staging', 'staged', 'verified', 'cleaning_staging')
			AND run.status IN ('failed', 'cancelled')
			AND COALESCE(run.finished_at, manifest.updated_at) < ?
		ORDER BY manifest.id ASC
	`, cutoff)
	if err != nil {
		return remoteFetchStagingCleanupResult{}, err
	}
	candidates := []fetchStagingCleanupCandidate{}
	for rows.Next() {
		var candidate fetchStagingCleanupCandidate
		if err := rows.Scan(&candidate.ManifestID, &candidate.RunID, &candidate.State); err != nil {
			_ = rows.Close()
			return remoteFetchStagingCleanupResult{}, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Close(); err != nil {
		return remoteFetchStagingCleanupResult{}, err
	}
	if err := rows.Err(); err != nil {
		return remoteFetchStagingCleanupResult{}, err
	}

	result := remoteFetchStagingCleanupResult{}
	for _, candidate := range candidates {
		claimed, err := s.claimRemoteFetchStagingCleanup(ctx, candidate, cutoff)
		if err != nil {
			return result, err
		}
		if !claimed {
			continue
		}
		stagingRelative := filepath.ToSlash(filepath.Join(".kikoto-staging", strconv.FormatInt(candidate.RunID, 10)))
		stagingPath, err := safeDataPath(s.cfg.DataRoot, stagingRelative)
		if err == nil {
			var removed removedFetchStaging
			removed, err = removeFetchStagingTree(s.cfg.DataRoot, stagingPath)
			if err == nil {
				if finishErr := s.finishRemoteFetchStagingCleanup(ctx, candidate, retentionDays, removed); finishErr != nil {
					return result, finishErr
				}
				result.Cleaned++
				result.Files += removed.Files
				result.Bytes += removed.Bytes
				continue
			}
		}
		result.Blocked++
		slog.Error("remote Fetch staging cleanup blocked", "run_id", candidate.RunID, "error", err)
		if restoreErr := s.blockRemoteFetchStagingCleanup(ctx, candidate); restoreErr != nil {
			return result, restoreErr
		}
	}
	return result, nil
}

func (s *Server) claimRemoteFetchStagingCleanup(ctx context.Context, candidate fetchStagingCleanupCandidate, cutoff string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = 'cleaning_staging', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND staging_cleaned_at IS NULL
			AND state = ?
			AND EXISTS (
				SELECT 1 FROM workflow_run
				WHERE workflow_run.id = remote_fetch_manifest.workflow_run_id
					AND workflow_run.status IN ('failed', 'cancelled')
					AND COALESCE(workflow_run.finished_at, remote_fetch_manifest.updated_at) < ?
			)
	`, candidate.ManifestID, candidate.State, cutoff)
	if err != nil {
		return false, err
	}
	rows, err := result.RowsAffected()
	return rows > 0, err
}

func (s *Server) finishRemoteFetchStagingCleanup(ctx context.Context, candidate fetchStagingCleanupCandidate, retentionDays int, removed removedFetchStaging) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET state = 'planned', staging_cleaned_at = CURRENT_TIMESTAMP,
			error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND state = 'cleaning_staging'
	`, candidate.ManifestID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("remote Fetch staging cleanup lost its manifest claim")
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE remote_fetch_manifest_item
		SET state = 'planned', content_hash = '', error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE manifest_id = ?
	`, candidate.ManifestID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, candidate.RunID, workflow.EventSpec{
		Level:   "info",
		Type:    "fetch.staging_cleaned",
		Message: "Expired Fetch staging data removed",
		Detail: map[string]any{
			"retention_days": retentionDays,
			"files_removed":  removed.Files,
			"bytes_removed":  removed.Bytes,
			"retry_ready":    true,
		},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) blockRemoteFetchStagingCleanup(ctx context.Context, candidate fetchStagingCleanupCandidate) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE remote_fetch_manifest
		SET updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND state = 'cleaning_staging'
	`, candidate.ManifestID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, candidate.RunID, workflow.EventSpec{
		Level:   "warn",
		Type:    "fetch.staging_cleanup_blocked",
		Message: "Fetch staging cleanup stopped at an unsafe or unexpected entry",
		Detail:  map[string]any{"retry_ready": false, "operator_review_required": true},
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func removeFetchStagingTree(dataRoot string, root string) (removedFetchStaging, error) {
	exists, err := validateFetchStagingPath(dataRoot, root)
	if err != nil {
		return removedFetchStaging{}, err
	}
	if !exists {
		return removedFetchStaging{}, nil
	}
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return removedFetchStaging{}, nil
	}
	if err != nil {
		return removedFetchStaging{}, err
	}
	if unsafeFetchStagingEntry(info) || !info.IsDir() {
		return removedFetchStaging{}, fmt.Errorf("Fetch staging root is not a regular directory")
	}
	if err := validateFetchStagingDirectory(root); err != nil {
		return removedFetchStaging{}, err
	}
	return removeFetchStagingDirectory(root)
}

// validateFetchStagingPath walks from the trusted configured data root to the
// fixed run directory. Checking only entries below the run directory would
// allow a symlink or Windows junction at .kikoto-staging to redirect cleanup
// outside /data.
func validateFetchStagingPath(dataRoot string, target string) (bool, error) {
	absRoot, err := filepath.Abs(dataRoot)
	if err != nil {
		return false, err
	}
	absTarget, err := filepath.Abs(target)
	if err != nil {
		return false, err
	}
	relative, err := filepath.Rel(absRoot, absTarget)
	if err != nil {
		return false, err
	}
	if relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return false, fmt.Errorf("Fetch staging path escapes the data root")
	}

	current := absRoot
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if unsafeFetchStagingEntry(info) {
			return false, fmt.Errorf("Fetch staging path contains a symbolic link or reparse point")
		}
		if !info.IsDir() {
			return false, fmt.Errorf("Fetch staging path contains a non-directory entry")
		}
	}
	return true, nil
}

func validateFetchStagingDirectory(directory string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(directory, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if unsafeFetchStagingEntry(info) {
			return fmt.Errorf("Fetch staging contains a symbolic link or reparse point")
		}
		if info.IsDir() {
			if err := validateFetchStagingDirectory(path); err != nil {
				return err
			}
			continue
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("Fetch staging contains an unsupported file type")
		}
	}
	return nil
}

func removeFetchStagingDirectory(directory string) (removedFetchStaging, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return removedFetchStaging{}, err
	}
	result := removedFetchStaging{}
	for _, entry := range entries {
		path := filepath.Join(directory, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			return result, err
		}
		if unsafeFetchStagingEntry(info) {
			return result, fmt.Errorf("Fetch staging contains a symbolic link or reparse point")
		}
		if info.IsDir() {
			removed, err := removeFetchStagingDirectory(path)
			if err != nil {
				return result, err
			}
			result.Files += removed.Files
			result.Bytes += removed.Bytes
			continue
		}
		if !info.Mode().IsRegular() {
			return result, fmt.Errorf("Fetch staging contains an unsupported file type")
		}
		if err := os.Remove(path); err != nil {
			return result, err
		}
		result.Files++
		result.Bytes += info.Size()
	}
	if err := os.Remove(directory); err != nil {
		return result, err
	}
	return result, nil
}
