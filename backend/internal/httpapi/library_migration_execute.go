package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func (s *Server) libraryMigrationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.layoutMigrationActive.Load() || r.URL.Path == "/health" ||
			strings.HasPrefix(r.URL.Path, "/api/auth/") || r.URL.Path == "/api/runtime-settings" ||
			strings.HasPrefix(r.URL.Path, "/api/library/migration") {
			next.ServeHTTP(w, r)
			return
		}
		writeAPIError(w, http.StatusServiceUnavailable, "site_maintenance", "The site is under maintenance. Please return later.", true)
	})
}

// ResumeLibraryMigration is started before the job runner. A failed migration
// remains in maintenance until an administrator retries it.
func (s *Server) ResumeLibraryMigration(ctx context.Context) {
	var status, raw string
	err := s.db.QueryRowContext(ctx, `SELECT status, plan_json FROM library_layout_migration WHERE id = 1`).Scan(&status, &raw)
	if errors.Is(err, sql.ErrNoRows) || ctx.Err() != nil {
		return
	}
	if err != nil {
		slog.Error("load storage migration", "error", err)
		return
	}
	if status != "running" {
		return
	}
	var plan layoutMigrationPlan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		s.failLibraryMigration(ctx, err)
		return
	}
	s.layoutMigrationActive.Store(true)
	s.executeLibraryMigration(ctx, plan)
}

func (s *Server) libraryMigrationPhase(ctx context.Context) (string, int64, error) {
	var phase string
	var runID sql.NullInt64
	err := s.db.QueryRowContext(ctx, `SELECT phase, scan_run_id FROM library_layout_migration WHERE id = 1`).Scan(&phase, &runID)
	return phase, runID.Int64, err
}

func (s *Server) setLibraryMigrationPhase(ctx context.Context, phase string, progress int) error {
	_, err := s.db.ExecContext(ctx, `UPDATE library_layout_migration SET phase = ?, progress_current = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, phase, progress)
	return err
}

func (s *Server) failLibraryMigration(ctx context.Context, err error) {
	if ctx.Err() != nil {
		return
	}
	slog.Error("library migration failed", "error", err)
	_, saveErr := s.db.ExecContext(ctx, `UPDATE library_layout_migration SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, err.Error())
	if saveErr != nil {
		slog.Error("record library migration failure", "error", saveErr)
	}
	s.layoutMigrationActive.Store(true)
}

func (s *Server) executeLibraryMigration(ctx context.Context, plan layoutMigrationPlan) {
	if err := s.runLibraryMigration(ctx, plan); err != nil {
		s.failLibraryMigration(ctx, err)
	}
}

func (s *Server) runLibraryMigration(ctx context.Context, plan layoutMigrationPlan) error {
	phase, _, err := s.libraryMigrationPhase(ctx)
	if err != nil {
		return err
	}
	if phase != "cleanup" && phase != "scan" {
		if plan.Requested.Mode == storagepool.ModePools {
			if _, err := s.registerStoragePools(ctx, plan.Current, plan.Requested.Pools); err != nil {
				return err
			}
		}
		var completedBytes int64
		for i, move := range plan.Moves {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := s.setLibraryMigrationPhase(ctx, "copy", i); err != nil {
				return err
			}
			if err := s.setLibraryMigrationBytes(ctx, completedBytes); err != nil {
				return err
			}
			base := completedBytes
			if err := s.stageLibraryMigrationMoveWithProgress(ctx, move, func(copied int64) error {
				return s.setLibraryMigrationBytes(ctx, base+copied)
			}); err != nil {
				return err
			}
			completedBytes += move.Bytes
		}
		if err := s.setLibraryMigrationBytes(ctx, plan.Bytes); err != nil {
			return err
		}
		if err := s.setLibraryMigrationPhase(ctx, "commit", len(plan.Moves)); err != nil {
			return err
		}
		if err := s.commitLibraryMigration(ctx, plan); err != nil {
			return err
		}
	}
	if phase != "scan" {
		for _, move := range plan.Moves {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := s.removeMigratedSource(move); err != nil {
				return err
			}
		}
		if err := s.setLibraryMigrationPhase(ctx, "scan", len(plan.Moves)); err != nil {
			return err
		}
	}
	s.layoutMigrationScan.Store(true)
	if err := s.waitForLibraryMigrationScan(ctx); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE library_layout_migration SET status = 'completed', phase = 'completed', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = 1`); err != nil {
		return err
	}
	s.layoutMigrationScan.Store(false)
	s.layoutMigrationActive.Store(false)
	s.notifyFilesystemTriggerConfigChanged()
	return nil
}

func (s *Server) stageLibraryMigrationMove(ctx context.Context, move layoutMigrationMove) error {
	return s.stageLibraryMigrationMoveWithProgress(ctx, move, nil)
}

func (s *Server) setLibraryMigrationBytes(ctx context.Context, bytes int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE library_layout_migration SET progress_bytes_current = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`, bytes)
	return err
}

func (s *Server) stageLibraryMigrationMoveWithProgress(ctx context.Context, move layoutMigrationMove, progress func(int64) error) error {
	if !validMigrationPath(move.From) || !validMigrationPath(move.To) {
		return errors.New("invalid saved migration path")
	}
	if err := rejectLinkedMigrationAncestors(s.cfg.DataRoot, move.From); err != nil {
		return err
	}
	if err := rejectLinkedMigrationAncestors(s.cfg.DataRoot, move.To); err != nil {
		return err
	}
	source := filepath.Join(s.cfg.DataRoot, filepath.FromSlash(move.From))
	destination := filepath.Join(s.cfg.DataRoot, filepath.FromSlash(move.To))
	_, sourceErr := os.Lstat(source)
	if errors.Is(sourceErr, os.ErrNotExist) {
		if _, err := os.Lstat(destination); err != nil {
			return fmt.Errorf("migration source and target are missing: %w", err)
		}
		return nil
	}
	if sourceErr != nil {
		return sourceErr
	}
	if _, err := os.Lstat(destination); err == nil {
		return verifyMigrationTrees(source, destination, true)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	temporary := destination + ".kikoto-migration-partial"
	if _, err := os.Lstat(temporary); err == nil {
		if err := removeMigrationTree(temporary); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := copyMigrationTree(ctx, source, temporary, progress); err != nil {
		return err
	}
	if err := verifyMigrationTrees(source, temporary, true); err != nil {
		return err
	}
	return os.Rename(temporary, destination)
}

type migrationProgressWriter struct {
	writer   io.Writer
	count    int64
	next     int64
	progress func(int64) error
}

func (w *migrationProgressWriter) Write(data []byte) (int, error) {
	n, err := w.writer.Write(data)
	w.count += int64(n)
	if err == nil && w.progress != nil && w.count >= w.next {
		err = w.progress(w.count)
		w.next = w.count + 16<<20
	}
	return n, err
}

func copyMigrationTree(ctx context.Context, source, destination string, progress func(int64) error) error {
	writer := &migrationProgressWriter{progress: progress, next: 16 << 20}
	return filepath.WalkDir(source, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("linked or special file in migration source")
		}
		rel, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		target := filepath.Join(destination, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		input, err := os.Open(name)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, info.Mode().Perm())
		if err != nil {
			_ = input.Close()
			return err
		}
		writer.writer = output
		_, copyErr := io.CopyBuffer(writer, input, make([]byte, 1<<20))
		if closeErr := input.Close(); copyErr == nil {
			copyErr = closeErr
		}
		if copyErr == nil {
			copyErr = output.Sync()
		}
		closeErr := output.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func verifyMigrationTrees(source, destination string, requireExact bool) error {
	seen := map[string]bool{}
	roots := []string{source}
	if requireExact {
		roots = append(roots, destination)
	}
	for _, root := range roots {
		err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			info, err := os.Lstat(name)
			if err != nil {
				return err
			}
			if info.Mode()&fs.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
				return errors.New("linked or special file in migration tree")
			}
			rel, err := filepath.Rel(root, name)
			if err != nil {
				return err
			}
			if root == source {
				seen[rel] = true
			} else if !seen[rel] {
				return errors.New("migration destination has an unexpected entry")
			}
			other := filepath.Join(destination, rel)
			if root == source {
				otherInfo, err := os.Lstat(other)
				if err != nil || otherInfo.IsDir() != info.IsDir() || (info.Mode().IsRegular() && otherInfo.Size() != info.Size()) {
					return errors.New("migration copy does not match source")
				}
				if info.Mode().IsRegular() {
					left, err := migrationFileHash(name)
					if err != nil {
						return err
					}
					right, err := migrationFileHash(other)
					if err != nil {
						return err
					}
					if left != right {
						return errors.New("migration copy checksum mismatch")
					}
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func migrationFileHash(name string) ([32]byte, error) {
	var value [32]byte
	file, err := os.Open(name)
	if err != nil {
		return value, err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	if _, err := io.CopyBuffer(hash, file, make([]byte, 1<<20)); err != nil {
		return value, err
	}
	copy(value[:], hash.Sum(nil))
	return value, nil
}

func (s *Server) removeMigratedSource(move layoutMigrationMove) error {
	if err := rejectLinkedMigrationAncestors(s.cfg.DataRoot, move.From); err != nil {
		return err
	}
	if err := rejectLinkedMigrationAncestors(s.cfg.DataRoot, move.To); err != nil {
		return err
	}
	source := filepath.Join(s.cfg.DataRoot, filepath.FromSlash(move.From))
	destination := filepath.Join(s.cfg.DataRoot, filepath.FromSlash(move.To))
	if _, err := os.Lstat(destination); err != nil {
		return err
	}
	if _, err := os.Lstat(source); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	// A previous cleanup may have removed part of the source before a restart.
	// Verify every remaining entry, while accepting extra already-copied files.
	if err := verifyMigrationTrees(source, destination, false); err != nil {
		return err
	}
	return removeMigrationTree(source)
}

// Remove children bottom-up with Lstat, never traversing a link or a device.
func removeMigrationTree(root string) error {
	paths := []string{}
	if err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("linked or special file in migration cleanup")
		}
		paths = append(paths, name)
		return nil
	}); err != nil {
		return err
	}
	for i := len(paths) - 1; i >= 0; i-- {
		if err := os.Remove(paths[i]); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) waitForLibraryMigrationScan(ctx context.Context) error {
	_, runID, err := s.libraryMigrationPhase(ctx)
	if err != nil {
		return err
	}
	if runID == 0 {
		run, err := s.enqueueLocalScan(ctx, "manual", "library_layout_migration")
		if err != nil {
			return err
		}
		runID = run.RunID
		if _, err := s.db.ExecContext(ctx, `UPDATE library_layout_migration SET scan_run_id = ? WHERE id = 1`, runID); err != nil {
			return err
		}
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		var status string
		if err := s.db.QueryRowContext(ctx, `SELECT status FROM workflow_run WHERE id = ?`, runID).Scan(&status); err != nil {
			return err
		}
		switch status {
		case "succeeded":
			return nil
		case "partial", "failed", "cancelled":
			return fmt.Errorf("migration scan ended with status %s", status)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Server) commitLibraryMigration(ctx context.Context, plan layoutMigrationPlan) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, item := range []struct{ table, column string }{
		{"work_folder_location", "root_path"}, {"work_source_presence", "source_url"},
		{"media_file_location", "path"}, {"remote_fetch_manifest", "target_root"},
		{"remote_fetch_manifest", "staging_root"}, {"remote_fetch_manifest", "backup_root"},
		{"remote_fetch_manifest_item", "target_path"}, {"remote_fetch_manifest_item", "source_path"},
		{"remote_fetch_manifest_item", "original_target_path"},
	} {
		if err := rewriteMigrationColumn(ctx, tx, item.table, item.column, plan.Paths, false, plan.Requested.Mode); err != nil {
			return err
		}
	}
	for _, item := range []struct{ table, column string }{
		{"remote_fetch_manifest", "plan_json"}, {"workflow_candidate", "payload_json"},
		{"workflow_candidate", "decision_json"}, {"workflow_job", "payload_json"},
		{"workflow_job", "checkpoint_json"},
	} {
		if err := rewriteMigrationColumn(ctx, tx, item.table, item.column, plan.Paths, true, plan.Requested.Mode); err != nil {
			return err
		}
	}
	if plan.Requested.Mode == storagepool.ModePools {
		pools := []storagepool.Pool{}
		for _, name := range plan.Requested.Pools {
			id, exists, err := storagepool.ReadMarker(filepath.Join(s.cfg.DataRoot, name))
			if err != nil || !exists {
				return errors.New("a target pool marker is unavailable")
			}
			pools = append(pools, storagepool.Pool{Path: name, ID: id})
		}
		for key, value := range map[string]any{settingLibraryMode: storagepool.ModePools, settingStoragePools: pools, settingFetchPool: plan.Requested.FetchPool} {
			if err := saveSettingValueTx(ctx, tx, key, value); err != nil {
				return err
			}
		}
	} else {
		if err := saveSettingValueTx(ctx, tx, settingLibraryMode, storagepool.ModeStandard); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE library_layout_migration SET phase = 'cleanup', updated_at = CURRENT_TIMESTAMP WHERE id = 1`); err != nil {
		return err
	}
	return tx.Commit()
}

func rewriteMigrationColumn(ctx context.Context, tx *sql.Tx, table, column string, replacements []layoutMigrationMove, isJSON bool, mode string) error {
	var after int64
	for {
		rows, err := tx.QueryContext(ctx, "SELECT rowid, "+column+" FROM "+table+" WHERE rowid > ? ORDER BY rowid LIMIT 256", after)
		if err != nil {
			return err
		}
		type item struct {
			id        int64
			old, next string
		}
		batch := []item{}
		for rows.Next() {
			var record item
			var raw sql.NullString
			if err := rows.Scan(&record.id, &raw); err != nil {
				_ = rows.Close()
				return err
			}
			record.old = raw.String
			record.next = record.old
			if isJSON {
				record.next = rewriteMigrationJSON(record.old, replacements, mode)
			} else {
				record.next = replaceMigrationPath(record.old, replacements)
			}
			batch = append(batch, record)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
		if len(batch) == 0 {
			return nil
		}
		for _, record := range batch {
			if record.next != record.old {
				if _, err := tx.ExecContext(ctx, "UPDATE "+table+" SET "+column+" = ? WHERE rowid = ?", record.next, record.id); err != nil {
					return err
				}
			}
		}
		after = batch[len(batch)-1].id
	}
}

func replaceMigrationPath(value string, replacements []layoutMigrationMove) string {
	for _, move := range replacements {
		if value == move.From {
			return move.To
		}
		if strings.HasPrefix(value, move.From+"/") {
			return move.To + strings.TrimPrefix(value, move.From)
		}
	}
	return value
}

func rewriteMigrationJSON(raw string, replacements []layoutMigrationMove, mode string) string {
	if raw == "" || !json.Valid([]byte(raw)) {
		return raw
	}
	var value any
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return raw
	}
	changed := false
	var rewrite func(string, any) any
	rewrite = func(key string, input any) any {
		switch item := input.(type) {
		case string:
			if !isMigrationPathField(key) {
				return item
			}
			updated := replaceMigrationPath(item, replacements)
			changed = changed || updated != item
			return updated
		case []any:
			for i := range item {
				item[i] = rewrite(key, item[i])
			}
			return item
		case map[string]any:
			for key, field := range item {
				item[key] = rewrite(key, field)
			}
			if saveRoot, ok := item["saveRoot"].(string); ok {
				pool := ""
				if mode == storagepool.ModePools {
					pool, _ = storagepool.Split(mode, saveRoot)
				}
				if _, present := item["transactionPool"]; present {
					changed = changed || item["transactionPool"] != pool
					item["transactionPool"] = pool
				}
			}
			return item
		default:
			return input
		}
	}
	value = rewrite("", value)
	if !changed {
		return raw
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return raw
	}
	return string(encoded)
}

func isMigrationPathField(key string) bool {
	key = strings.ToLower(strings.ReplaceAll(key, "_", ""))
	return key == "path" || key == "root" || key == "paths" || key == "roots" ||
		strings.HasSuffix(key, "path") || strings.HasSuffix(key, "root") ||
		strings.HasSuffix(key, "paths") || strings.HasSuffix(key, "roots")
}
