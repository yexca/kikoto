package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const (
	databaseCleanupRunRetention         = "-90 days"
	databaseCleanupEventRetention       = "-90 days"
	databaseCleanupGenerationGrace      = "-1 day"
	maxDatabaseCleanupDiskChecks        = 50000
	maxDatabaseCleanupMediaItemPasses   = 32
	databaseCleanupTaskMissingFolders   = "missing_folders"
	databaseCleanupTaskMissingFiles     = "missing_files"
	databaseCleanupTaskEmptyMediaItems  = "empty_media_items"
	databaseCleanupTaskMissingPresence  = "missing_presence"
	databaseCleanupTaskOrphanSnapshots  = "orphan_snapshots"
	databaseCleanupTaskUnusedTags       = "unused_tags"
	databaseCleanupTaskExpiredSessions  = "expired_sessions"
	databaseCleanupTaskNotifications    = "dismissed_notifications"
	databaseCleanupTaskOldRuns          = "old_runs"
	databaseCleanupTaskOldRecommendEvts = "old_recommendation_events"
	databaseCleanupTaskStaleGenerations = "stale_recommendation_generations"
)

// databaseCleanupTaskOrder is also the public list of accepted task keys.
// Path tasks run first so that the media-item and presence tasks see the
// records they leave behind within the same cleanup request.
var databaseCleanupTaskOrder = []string{
	databaseCleanupTaskMissingFolders,
	databaseCleanupTaskMissingFiles,
	databaseCleanupTaskEmptyMediaItems,
	databaseCleanupTaskMissingPresence,
	databaseCleanupTaskOrphanSnapshots,
	databaseCleanupTaskUnusedTags,
	databaseCleanupTaskExpiredSessions,
	databaseCleanupTaskNotifications,
	databaseCleanupTaskOldRuns,
	databaseCleanupTaskOldRecommendEvts,
	databaseCleanupTaskStaleGenerations,
}

// Removing path records leaves their dependents behind, so a path task also
// runs the tasks that clean up after it in the same request.
var databaseCleanupImpliedTasks = map[string][]string{
	databaseCleanupTaskMissingFolders: {databaseCleanupTaskMissingPresence},
	databaseCleanupTaskMissingFiles:   {databaseCleanupTaskEmptyMediaItems, databaseCleanupTaskMissingPresence},
}

var databaseCleanupDiskTasks = map[string]bool{
	databaseCleanupTaskMissingFolders: true,
	databaseCleanupTaskMissingFiles:   true,
}

type databaseCleanupTaskSummary struct {
	Key       string `json:"key"`
	Count     int    `json:"count"`
	Available bool   `json:"available"`
}

type databaseMaintenanceOverview struct {
	ScannedAt         string                       `json:"scannedAt"`
	DatabaseBytes     int64                        `json:"databaseBytes"`
	FreeBytes         int64                        `json:"freeBytes"`
	WALBytes          int64                        `json:"walBytes"`
	DataRootAvailable bool                         `json:"dataRootAvailable"`
	Tasks             []databaseCleanupTaskSummary `json:"tasks"`
}

type databaseCleanupRequest struct {
	Tasks []string `json:"tasks"`
}

type databaseCleanupTaskResult struct {
	Key     string `json:"key"`
	Removed int    `json:"removed"`
	Skipped bool   `json:"skipped"`
}

type databaseCleanupResult struct {
	Results []databaseCleanupTaskResult `json:"results"`
	Removed int                         `json:"removed"`
}

type databaseOptimizeResult struct {
	BeforeBytes int64 `json:"beforeBytes"`
	AfterBytes  int64 `json:"afterBytes"`
}

type staleDiskRecord struct {
	ID   int64
	Path string
}

func (s *Server) getDatabaseMaintenance(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	overview, err := s.scanDatabaseMaintenance(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (s *Server) cleanupDatabase(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	var request databaseCleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	requested := map[string]bool{}
	for _, key := range request.Tasks {
		key = strings.TrimSpace(key)
		if !isDatabaseCleanupTask(key) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown cleanup task"})
			return
		}
		requested[key] = true
	}
	if len(requested) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "select at least one cleanup task"})
		return
	}
	dataRootAvailable := s.databaseCleanupDataRootAvailable()
	for key := range requested {
		if databaseCleanupDiskTasks[key] && !dataRootAvailable {
			continue
		}
		for _, implied := range databaseCleanupImpliedTasks[key] {
			requested[implied] = true
		}
	}
	result := databaseCleanupResult{Results: []databaseCleanupTaskResult{}}
	for _, key := range databaseCleanupTaskOrder {
		if !requested[key] {
			continue
		}
		if databaseCleanupDiskTasks[key] && !dataRootAvailable {
			result.Results = append(result.Results, databaseCleanupTaskResult{Key: key, Skipped: true})
			continue
		}
		removed, err := s.runDatabaseCleanupTask(r.Context(), key)
		if err != nil {
			writeError(w, err)
			return
		}
		result.Removed += removed
		result.Results = append(result.Results, databaseCleanupTaskResult{Key: key, Removed: removed})
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
		VALUES (?, 'database.cleanup', 'database', '', ?)
	`, user.ID, mustJSON(result.Results)); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) optimizeDatabase(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	before, _, err := s.databaseFileUsage(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	for _, statement := range []string{"VACUUM", "PRAGMA optimize"} {
		if _, err := s.db.ExecContext(r.Context(), statement); err != nil {
			writeError(w, err)
			return
		}
	}
	var busy, logPages, checkpointed int
	_ = s.db.QueryRowContext(r.Context(), "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logPages, &checkpointed)
	after, _, err := s.databaseFileUsage(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
		VALUES (?, 'database.optimize', 'database', '', ?)
	`, user.ID, mustJSON(databaseOptimizeResult{BeforeBytes: before, AfterBytes: after})); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, databaseOptimizeResult{BeforeBytes: before, AfterBytes: after})
}

func isDatabaseCleanupTask(key string) bool {
	for _, candidate := range databaseCleanupTaskOrder {
		if candidate == key {
			return true
		}
	}
	return false
}

func (s *Server) scanDatabaseMaintenance(ctx context.Context) (databaseMaintenanceOverview, error) {
	databaseBytes, freeBytes, err := s.databaseFileUsage(ctx)
	if err != nil {
		return databaseMaintenanceOverview{}, err
	}
	overview := databaseMaintenanceOverview{
		ScannedAt:         time.Now().UTC().Format(time.RFC3339),
		DatabaseBytes:     databaseBytes,
		FreeBytes:         freeBytes,
		DataRootAvailable: s.databaseCleanupDataRootAvailable(),
		Tasks:             make([]databaseCleanupTaskSummary, 0, len(databaseCleanupTaskOrder)),
	}
	if path := strings.TrimSpace(s.cfg.DatabasePath); path != "" {
		if info, err := os.Stat(path + "-wal"); err == nil {
			overview.WALBytes = info.Size()
		}
	}
	for _, key := range databaseCleanupTaskOrder {
		summary := databaseCleanupTaskSummary{Key: key, Available: true}
		if databaseCleanupDiskTasks[key] && !overview.DataRootAvailable {
			summary.Available = false
			overview.Tasks = append(overview.Tasks, summary)
			continue
		}
		count, err := s.countDatabaseCleanupTask(ctx, key)
		if err != nil {
			return databaseMaintenanceOverview{}, err
		}
		summary.Count = count
		overview.Tasks = append(overview.Tasks, summary)
	}
	return overview, nil
}

func (s *Server) databaseFileUsage(ctx context.Context) (int64, int64, error) {
	var pageCount, pageSize, freePages int64
	if err := s.db.QueryRowContext(ctx, "PRAGMA page_count").Scan(&pageCount); err != nil {
		return 0, 0, err
	}
	if err := s.db.QueryRowContext(ctx, "PRAGMA page_size").Scan(&pageSize); err != nil {
		return 0, 0, err
	}
	if err := s.db.QueryRowContext(ctx, "PRAGMA freelist_count").Scan(&freePages); err != nil {
		return 0, 0, err
	}
	return pageCount * pageSize, freePages * pageSize, nil
}

// databaseCleanupDataRootAvailable refuses disk-verified cleanup when the data
// root is missing or empty, which is what an unmounted volume looks like. In
// that state every local path would appear stale.
func (s *Server) databaseCleanupDataRootAvailable() bool {
	root := strings.TrimSpace(s.cfg.DataRoot)
	if root == "" {
		return false
	}
	directory, err := os.Open(root)
	if err != nil {
		return false
	}
	defer func() { _ = directory.Close() }()
	info, err := directory.Stat()
	if err != nil || !info.IsDir() {
		return false
	}
	entries, err := directory.Readdirnames(1)
	return err == nil && len(entries) > 0
}

func (s *Server) countDatabaseCleanupTask(ctx context.Context, key string) (int, error) {
	switch key {
	case databaseCleanupTaskMissingFolders:
		records, err := s.staleMissingFolderLocations(ctx)
		return len(records), err
	case databaseCleanupTaskMissingFiles:
		records, err := s.staleMissingFileLocations(ctx)
		return len(records), err
	}
	query, ok := databaseCleanupCountQueries[key]
	if !ok {
		return 0, errors.New("unknown cleanup task")
	}
	var count int
	err := s.db.QueryRowContext(ctx, query).Scan(&count)
	return count, err
}

func (s *Server) runDatabaseCleanupTask(ctx context.Context, key string) (int, error) {
	switch key {
	case databaseCleanupTaskMissingFolders:
		records, err := s.staleMissingFolderLocations(ctx)
		if err != nil {
			return 0, err
		}
		return s.deleteStaleDiskRecords(ctx, records, `
			DELETE FROM work_folder_location WHERE id = ? AND state = 'missing'
		`)
	case databaseCleanupTaskMissingFiles:
		records, err := s.staleMissingFileLocations(ctx)
		if err != nil {
			return 0, err
		}
		return s.deleteStaleDiskRecords(ctx, records, `
			DELETE FROM media_file_location WHERE id = ? AND location_type = 'local' AND availability = 'missing'
		`)
	case databaseCleanupTaskEmptyMediaItems:
		return s.deleteEmptyMediaItems(ctx)
	}
	query, ok := databaseCleanupDeleteQueries[key]
	if !ok {
		return 0, errors.New("unknown cleanup task")
	}
	result, err := s.db.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	return int(affected), err
}

// Remote items without a stream URL are expected placeholders that the next
// source sync recreates, so only locally indexed items are considered.
const emptyMediaItemCondition = `
	item.fingerprint LIKE 'local:%'
	AND NOT EXISTS (SELECT 1 FROM media_file_location AS location WHERE location.media_item_id = item.id)
	AND NOT EXISTS (SELECT 1 FROM media_item AS child WHERE child.parent_id = item.id)
`

const missingLocalPresenceCondition = `
	presence.presence_type = 'local'
	AND presence.availability = 'missing'
	AND EXISTS (
		SELECT 1 FROM file_source AS source
		WHERE source.id = presence.file_source_id AND source.source_type = 'local_folder'
	)
	AND NOT EXISTS (
		SELECT 1 FROM work_folder_location AS folder
		WHERE folder.work_id = presence.work_id
			AND folder.file_source_id = presence.file_source_id
			AND folder.state != 'missing'
	)
	AND NOT EXISTS (
		SELECT 1
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = presence.work_id
			AND location.file_source_id = presence.file_source_id
			AND location.location_type = 'local'
			AND location.availability != 'missing'
	)
`

// Old runs are removed only when nothing durable depends on them: Fetch
// transactions, review candidates, metadata issue history, cleanup
// provenance, and the latest run of every workflow all stay.
const oldWorkflowRunCondition = `
	run.status IN ('succeeded', 'failed', 'cancelled')
	AND COALESCE(run.finished_at, run.created_at) < datetime('now', '` + databaseCleanupRunRetention + `')
	AND run.id NOT IN (SELECT MAX(id) FROM workflow_run GROUP BY workflow_code)
	AND NOT EXISTS (SELECT 1 FROM remote_fetch_manifest AS manifest WHERE manifest.workflow_run_id = run.id)
	AND NOT EXISTS (SELECT 1 FROM remote_fetch_request AS request WHERE request.workflow_run_id = run.id)
	AND NOT EXISTS (SELECT 1 FROM workflow_candidate AS candidate WHERE candidate.workflow_run_id = run.id)
	AND NOT EXISTS (SELECT 1 FROM metadata_sync_attempt_run AS attempt WHERE attempt.workflow_run_id = run.id)
	AND NOT EXISTS (SELECT 1 FROM work_folder_location AS folder WHERE folder.cleanup_run_id = run.id)
`

const staleRecommendationGenerationCondition = `
	generation.created_at < datetime('now', '` + databaseCleanupGenerationGrace + `')
	AND NOT EXISTS (
		SELECT 1 FROM recommendation_snapshot_state AS state
		WHERE state.current_generation_id = generation.id
	)
	AND NOT EXISTS (
		SELECT 1 FROM recommendation_client_session AS session
		WHERE session.generation_id = generation.id
	)
`

var databaseCleanupCountQueries = map[string]string{
	databaseCleanupTaskEmptyMediaItems:  `SELECT COUNT(*) FROM media_item AS item WHERE ` + emptyMediaItemCondition,
	databaseCleanupTaskMissingPresence:  `SELECT COUNT(*) FROM work_source_presence AS presence WHERE ` + missingLocalPresenceCondition,
	databaseCleanupTaskOrphanSnapshots:  `SELECT COUNT(*) FROM metadata_snapshot WHERE work_id IS NULL`,
	databaseCleanupTaskUnusedTags:       `SELECT COUNT(*) FROM tag WHERE is_user_defined = 0 AND NOT EXISTS (SELECT 1 FROM work_tag WHERE work_tag.tag_id = tag.id)`,
	databaseCleanupTaskExpiredSessions:  `SELECT COUNT(*) FROM user_session WHERE expires_at < datetime('now')`,
	databaseCleanupTaskNotifications:    `SELECT COUNT(*) FROM workflow_notification WHERE dismissed_at IS NOT NULL`,
	databaseCleanupTaskOldRuns:          `SELECT COUNT(*) FROM workflow_run AS run WHERE ` + oldWorkflowRunCondition,
	databaseCleanupTaskOldRecommendEvts: `SELECT COUNT(*) FROM recommendation_event WHERE created_at < datetime('now', '` + databaseCleanupEventRetention + `')`,
	databaseCleanupTaskStaleGenerations: `SELECT COUNT(*) FROM recommendation_generation AS generation WHERE ` + staleRecommendationGenerationCondition,
}

var databaseCleanupDeleteQueries = map[string]string{
	databaseCleanupTaskMissingPresence: `
		DELETE FROM work_source_presence
		WHERE rowid IN (SELECT presence.rowid FROM work_source_presence AS presence WHERE ` + missingLocalPresenceCondition + `)`,
	databaseCleanupTaskOrphanSnapshots:  `DELETE FROM metadata_snapshot WHERE work_id IS NULL`,
	databaseCleanupTaskUnusedTags:       `DELETE FROM tag WHERE is_user_defined = 0 AND NOT EXISTS (SELECT 1 FROM work_tag WHERE work_tag.tag_id = tag.id)`,
	databaseCleanupTaskExpiredSessions:  `DELETE FROM user_session WHERE expires_at < datetime('now')`,
	databaseCleanupTaskNotifications:    `DELETE FROM workflow_notification WHERE dismissed_at IS NOT NULL`,
	databaseCleanupTaskOldRuns:          `DELETE FROM workflow_run WHERE id IN (SELECT run.id FROM workflow_run AS run WHERE ` + oldWorkflowRunCondition + `)`,
	databaseCleanupTaskOldRecommendEvts: `DELETE FROM recommendation_event WHERE created_at < datetime('now', '` + databaseCleanupEventRetention + `')`,
	databaseCleanupTaskStaleGenerations: `
		DELETE FROM recommendation_generation
		WHERE id IN (SELECT generation.id FROM recommendation_generation AS generation WHERE ` + staleRecommendationGenerationCondition + `)`,
}

func (s *Server) staleMissingFolderLocations(ctx context.Context) ([]staleDiskRecord, error) {
	return s.staleDiskRecords(ctx, `
		SELECT folder.id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE folder.state = 'missing' AND source.source_type = 'local_folder'
		ORDER BY folder.id
		LIMIT ?
	`)
}

func (s *Server) staleMissingFileLocations(ctx context.Context) ([]staleDiskRecord, error) {
	return s.staleDiskRecords(ctx, `
		SELECT location.id, location.path
		FROM media_file_location AS location
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE location.location_type = 'local'
			AND location.availability = 'missing'
			AND source.source_type = 'local_folder'
		ORDER BY location.id
		LIMIT ?
	`)
}

// staleDiskRecords returns records whose relative data path is confirmed
// absent. A path that cannot be resolved inside the data root is left alone
// rather than treated as missing.
func (s *Server) staleDiskRecords(ctx context.Context, query string) ([]staleDiskRecord, error) {
	rows, err := s.db.QueryContext(ctx, query, maxDatabaseCleanupDiskChecks)
	if err != nil {
		return nil, err
	}
	candidates := []staleDiskRecord{}
	for rows.Next() {
		var record staleDiskRecord
		if err := rows.Scan(&record.ID, &record.Path); err != nil {
			_ = rows.Close()
			return nil, err
		}
		candidates = append(candidates, record)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	stale := []staleDiskRecord{}
	for _, record := range candidates {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, strings.TrimSpace(record.Path))
		if err != nil {
			continue
		}
		if _, err := os.Lstat(absolute); errors.Is(err, os.ErrNotExist) {
			stale = append(stale, record)
		}
	}
	return stale, nil
}

func (s *Server) deleteStaleDiskRecords(ctx context.Context, records []staleDiskRecord, statement string) (int, error) {
	if len(records) == 0 {
		return 0, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	removed := 0
	for _, record := range records {
		result, err := tx.ExecContext(ctx, statement, record.ID)
		if err != nil {
			return 0, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		removed += int(affected)
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return removed, nil
}

// deleteEmptyMediaItems repeats so that a folder item emptied by the previous
// pass is removed too, bounded by the deepest plausible directory nesting.
func (s *Server) deleteEmptyMediaItems(ctx context.Context) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	removed := 0
	for pass := 0; pass < maxDatabaseCleanupMediaItemPasses; pass++ {
		affected, err := execRowsAffected(ctx, tx, `
			DELETE FROM media_item
			WHERE id IN (SELECT item.id FROM media_item AS item WHERE `+emptyMediaItemCondition+`)
		`)
		if err != nil {
			return 0, err
		}
		if affected == 0 {
			break
		}
		removed += affected
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return removed, nil
}

func execRowsAffected(ctx context.Context, tx *sql.Tx, statement string, args ...any) (int, error) {
	result, err := tx.ExecContext(ctx, statement, args...)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	return int(affected), err
}
