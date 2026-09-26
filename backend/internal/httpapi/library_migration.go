package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// Layout changes are a durable, single-instance maintenance operation. All
// paths in a plan are relative to DataRoot and are checked before use.
type layoutMigrationMove struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Bytes int64  `json:"bytes"`
}

type layoutMigrationPlan struct {
	Current   libraryLayout         `json:"current"`
	Requested libraryLayoutUpdate   `json:"requested"`
	Moves     []layoutMigrationMove `json:"moves"`
	Paths     []layoutMigrationMove `json:"paths"`
	Bytes     int64                 `json:"bytes"`
}

type layoutMigrationPreview struct {
	Hash      string `json:"hash"`
	Mode      string `json:"mode"`
	MoveCount int    `json:"moveCount"`
	Bytes     int64  `json:"bytes"`
}

type layoutMigrationRequest struct {
	LibraryLayoutUpdate libraryLayoutUpdate `json:"layout"`
	Hash                string              `json:"hash"`
}

type layoutMigrationStatus struct {
	Status               string `json:"status"`
	Phase                string `json:"phase"`
	ProgressCurrent      int    `json:"progressCurrent"`
	ProgressTotal        int    `json:"progressTotal"`
	ProgressBytesCurrent int64  `json:"progressBytesCurrent"`
	ProgressBytesTotal   int64  `json:"progressBytesTotal"`
	Message              string `json:"message,omitempty"`
}

func (s *Server) previewLibraryMigration(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var payload libraryLayoutUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "Choose a library layout.", false)
		return
	}
	plan, err := s.buildLibraryMigrationPlan(r.Context(), payload)
	if err != nil {
		writeLayoutMigrationError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, migrationPreview(plan))
}

func migrationPreview(plan layoutMigrationPlan) layoutMigrationPreview {
	encoded, _ := json.Marshal(plan)
	digest := sha256.Sum256(encoded)
	return layoutMigrationPreview{Hash: hex.EncodeToString(digest[:]), Mode: plan.Requested.Mode, MoveCount: len(plan.Moves), Bytes: plan.Bytes}
}

func writeLayoutMigrationError(w http.ResponseWriter, err error) {
	var layoutErr libraryLayoutError
	if errors.As(err, &layoutErr) {
		writeAPIError(w, layoutErr.status, layoutErr.code, layoutErr.message, false)
		return
	}
	slog.Error("prepare library migration", "error", err)
	writeAPIError(w, http.StatusConflict, "library_migration_unavailable", "The storage change cannot start. Check the library and storage pools.", false)
}

func (s *Server) startLibraryMigration(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "demo_read_only", "Demo mode cannot change the library.", false)
		return
	}
	var request layoutMigrationRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Hash == "" {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "Review the storage change before confirming.", false)
		return
	}
	s.layoutMigrationMu.Lock()
	defer s.layoutMigrationMu.Unlock()
	if s.layoutMigrationActive.Load() {
		writeAPIError(w, http.StatusConflict, "library_migration_running", "A storage change is already in progress.", false)
		return
	}
	plan, err := s.buildLibraryMigrationPlan(r.Context(), request.LibraryLayoutUpdate)
	if err != nil {
		writeLayoutMigrationError(w, err)
		return
	}
	if migrationPreview(plan).Hash != request.Hash {
		writeAPIError(w, http.StatusConflict, "library_migration_plan_changed", "The library changed. Review the storage change again.", false)
		return
	}
	if len(s.workflowLeases.live()) != 0 {
		writeAPIError(w, http.StatusConflict, "library_busy", "Wait for active background work to finish, then try again.", true)
		return
	}
	var active int
	if err := s.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM workflow_job WHERE status IN ('queued', 'running')`).Scan(&active); err != nil {
		writeError(w, err)
		return
	}
	if active != 0 {
		writeAPIError(w, http.StatusConflict, "library_busy", "Wait for queued background work to finish, then try again.", true)
		return
	}
	encoded, err := json.Marshal(plan)
	if err != nil {
		writeError(w, err)
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		INSERT INTO library_layout_migration (id, status, phase, requested_json, plan_json, progress_total, progress_bytes_total)
		VALUES (1, 'running', 'prepare', ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET status = 'running', phase = 'prepare', requested_json = excluded.requested_json,
		  plan_json = excluded.plan_json, progress_current = 0, progress_total = excluded.progress_total,
		  progress_bytes_current = 0, progress_bytes_total = excluded.progress_bytes_total, scan_run_id = NULL,
		  error_message = '', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE library_layout_migration.status != 'running'
	`, string(mustJSON(plan.Requested)), string(encoded), len(plan.Moves), plan.Bytes)
	if err != nil {
		writeError(w, err)
		return
	}
	changed, err := result.RowsAffected()
	if err != nil || changed != 1 {
		writeAPIError(w, http.StatusConflict, "library_migration_running", "A storage change is already in progress.", false)
		return
	}
	s.layoutMigrationActive.Store(true)
	if !s.Go(func(ctx context.Context) { s.executeLibraryMigration(ctx, plan) }) {
		s.layoutMigrationActive.Store(false)
		_, _ = s.db.ExecContext(context.Background(), `UPDATE library_layout_migration SET status = 'failed', error_message = 'Server stopped before migration started' WHERE id = 1`)
		writeAPIError(w, http.StatusServiceUnavailable, "service_stopping", "The server is stopping.", true)
		return
	}
	writeJSON(w, http.StatusAccepted, layoutMigrationStatus{Status: "running", Phase: "prepare", ProgressTotal: len(plan.Moves), ProgressBytesTotal: plan.Bytes})
}

func (s *Server) getLibraryMigration(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	status, err := s.loadLibraryMigrationStatus(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) getPublicLibraryMigration(w http.ResponseWriter, r *http.Request) {
	if s.layoutMigrationActive.Load() {
		writeJSON(w, http.StatusOK, map[string]bool{"maintenance": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"maintenance": false})
}

func (s *Server) loadLibraryMigrationStatus(ctx context.Context) (layoutMigrationStatus, error) {
	var status layoutMigrationStatus
	err := s.db.QueryRowContext(ctx, `SELECT status, phase, progress_current, progress_total, progress_bytes_current, progress_bytes_total FROM library_layout_migration WHERE id = 1`).Scan(
		&status.Status, &status.Phase, &status.ProgressCurrent, &status.ProgressTotal, &status.ProgressBytesCurrent, &status.ProgressBytesTotal)
	if errors.Is(err, sql.ErrNoRows) {
		return layoutMigrationStatus{Status: "idle"}, nil
	}
	return status, err
}

func (s *Server) retryLibraryMigration(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	s.layoutMigrationMu.Lock()
	defer s.layoutMigrationMu.Unlock()
	var status, raw string
	err := s.db.QueryRowContext(r.Context(), `SELECT status, plan_json FROM library_layout_migration WHERE id = 1`).Scan(&status, &raw)
	if err != nil || status != "failed" {
		writeAPIError(w, http.StatusConflict, "library_migration_not_failed", "There is no failed storage change to retry.", false)
		return
	}
	var plan layoutMigrationPlan
	if err := json.Unmarshal([]byte(raw), &plan); err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `UPDATE library_layout_migration SET status = 'running', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = 1`); err != nil {
		writeError(w, err)
		return
	}
	s.layoutMigrationActive.Store(true)
	if phase, _, err := s.libraryMigrationPhase(r.Context()); err == nil && phase == "scan" {
		_, _ = s.db.ExecContext(r.Context(), `UPDATE library_layout_migration SET scan_run_id = NULL WHERE id = 1`)
	}
	if !s.Go(func(ctx context.Context) { s.executeLibraryMigration(ctx, plan) }) {
		_, _ = s.db.ExecContext(context.Background(), `UPDATE library_layout_migration SET status = 'failed', error_message = 'Server stopped before retry started' WHERE id = 1`)
		writeAPIError(w, http.StatusServiceUnavailable, "service_stopping", "The server is stopping.", true)
		return
	}
	writeJSON(w, http.StatusAccepted, layoutMigrationStatus{Status: "running", Phase: "retry", ProgressTotal: len(plan.Moves), ProgressBytesTotal: plan.Bytes})
}

func (s *Server) buildLibraryMigrationPlan(ctx context.Context, requested libraryLayoutUpdate) (layoutMigrationPlan, error) {
	current, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return layoutMigrationPlan{}, err
	}
	if !current.configured() || (requested.Mode == current.Mode &&
		(requested.Mode != storagepool.ModePools || requested.FetchPool == current.FetchPool)) {
		return layoutMigrationPlan{}, invalidLibraryLayout("library_migration_not_needed", "Choose a different library mode or Fetch pool.")
	}
	if requested.Mode != storagepool.ModeStandard && requested.Mode != storagepool.ModePools {
		return layoutMigrationPlan{}, invalidLibraryLayout("library_mode_invalid", "Choose a valid library mode.")
	}
	if requested.Mode == storagepool.ModePools {
		if len(requested.Pools) == 0 {
			return layoutMigrationPlan{}, invalidLibraryLayout("storage_pool_required", "Choose at least one storage pool.")
		}
		seen := map[string]bool{}
		for _, name := range requested.Pools {
			if !storagepool.ValidName(name) || seen[strings.ToLower(name)] || !storagepool.IsDirectory(filepath.Join(s.cfg.DataRoot, name)) {
				return layoutMigrationPlan{}, invalidLibraryLayout("storage_pool_invalid", "Choose existing, distinct storage pool folders.")
			}
			seen[strings.ToLower(name)] = true
			if err := storagepool.ProbeRename(filepath.Join(s.cfg.DataRoot, name)); err != nil {
				return layoutMigrationPlan{}, invalidLibraryLayout("storage_pool_not_writable", "A selected storage pool is not writable.")
			}
		}
		if requested.FetchPool != "" && !seen[strings.ToLower(requested.FetchPool)] {
			return layoutMigrationPlan{}, invalidLibraryLayout("fetch_pool_invalid", "Choose a Fetch pool from the selected pools.")
		}
		sort.Strings(requested.Pools)
		if current.poolsMode() {
			currentNames := make([]string, 0, len(current.Pools))
			for _, pool := range current.Pools {
				currentNames = append(currentNames, pool.Path)
			}
			sort.Strings(currentNames)
			if !slices.Equal(currentNames, requested.Pools) {
				return layoutMigrationPlan{}, invalidLibraryLayout("storage_pool_selection_changed", "Save storage pool selection separately before moving the Fetch pool.")
			}
		}
	}
	states, err := s.libraryPoolStates(ctx, s.cfg.DataRoot, current)
	if err != nil {
		return layoutMigrationPlan{}, err
	}
	for _, state := range states {
		if !state.Online {
			return layoutMigrationPlan{}, invalidLibraryLayout("storage_pool_offline", "Bring every current storage pool online before changing modes.")
		}
	}
	// Checking an older standard root may create its durable pool marker.
	// Include the saved marker ID in both preview and confirmation hashes.
	if !current.poolsMode() {
		current, err = s.loadLibraryLayout(ctx)
		if err != nil {
			return layoutMigrationPlan{}, err
		}
	}
	plan := layoutMigrationPlan{Current: current, Requested: requested, Moves: []layoutMigrationMove{}, Paths: []layoutMigrationMove{}}
	roots, fetchRoots, err := s.libraryMigrationRoots(ctx)
	if err != nil {
		return layoutMigrationPlan{}, err
	}
	for _, root := range roots {
		to, err := rebaseLibraryRoot(current, requested, root, fetchRoots[root])
		if err != nil {
			return layoutMigrationPlan{}, err
		}
		if root == to {
			continue
		}
		plan.Paths = append(plan.Paths, layoutMigrationMove{From: root, To: to})
		if err := s.addMigrationMove(&plan, root, to); err != nil {
			return layoutMigrationPlan{}, err
		}
	}
	// A standard library may contain newly copied work folders that have not
	// been indexed yet. Discover only local work folders within the current
	// scan scope so changing modes cannot strand those visible files.
	if requested.Mode != current.Mode {
		scope, err := s.localScanScope(ctx, s.cfg.DataRoot, s.configuredLocalScanDepth(ctx))
		if err != nil {
			return layoutMigrationPlan{}, err
		}
		folders, _, err := localfs.DiscoverFolders(s.cfg.DataRoot, localfs.Options{
			ScanDepth: scope.walkDepth(), SubRoots: scope.subRoots(),
		})
		if err != nil {
			return layoutMigrationPlan{}, err
		}
		for _, folder := range scope.filterFolders(folders) {
			root := folder.RelPath
			covered := false
			for _, mapped := range plan.Paths {
				if root == mapped.From || strings.HasPrefix(root, mapped.From+"/") {
					covered = true
					break
				}
			}
			if covered {
				continue
			}
			to, err := rebaseLibraryRoot(current, requested, root, false)
			if err != nil {
				return layoutMigrationPlan{}, err
			}
			if root == to {
				continue
			}
			plan.Paths = append(plan.Paths, layoutMigrationMove{From: root, To: to})
			if err := s.addMigrationMove(&plan, root, to); err != nil {
				return layoutMigrationPlan{}, err
			}
		}
	}
	if err := s.addTransactionMigrationMoves(ctx, &plan); err != nil {
		return layoutMigrationPlan{}, err
	}
	if err := s.addManifestMigrationPaths(ctx, &plan); err != nil {
		return layoutMigrationPlan{}, err
	}
	seenPaths := map[string]string{}
	uniquePaths := plan.Paths[:0]
	for _, item := range plan.Paths {
		if prior, exists := seenPaths[item.From]; exists {
			if prior != item.To {
				return layoutMigrationPlan{}, invalidLibraryLayout("library_path_conflict", "Saved Fetch paths disagree about their destination.")
			}
			continue
		}
		seenPaths[item.From] = item.To
		uniquePaths = append(uniquePaths, item)
	}
	plan.Paths = uniquePaths
	sort.Slice(plan.Paths, func(i, j int) bool { return len(plan.Paths[i].From) > len(plan.Paths[j].From) })
	sort.Slice(plan.Moves, func(i, j int) bool { return plan.Moves[i].From < plan.Moves[j].From })
	return plan, nil
}

func validMigrationPath(rel string) bool {
	return rel != "" && rel != "." && rel == path.Clean(rel) && !strings.HasPrefix(rel, "/") &&
		!strings.ContainsAny(rel, "\\:") && rel != ".." && !strings.HasPrefix(rel, "../") && !strings.Contains(rel, "/../")
}

func rejectLinkedMigrationAncestors(root, rel string) error {
	if !validMigrationPath(rel) {
		return errors.New("invalid library migration path")
	}
	current := root
	for _, component := range strings.Split(rel, "/") {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return errors.New("linked library migration path")
		}
	}
	return nil
}

func rebaseLibraryRoot(current libraryLayout, target libraryLayoutUpdate, root string, fetchRoot bool) (string, error) {
	if !validMigrationPath(root) {
		return "", invalidLibraryLayout("library_path_invalid", "A saved library path is invalid.")
	}
	if target.Mode == storagepool.ModePools {
		if current.poolsMode() && fetchRoot && current.FetchPool != target.FetchPool && target.FetchPool != "" {
			_, rest := storagepool.Split(storagepool.ModePools, root)
			if rest == "" {
				return "", invalidLibraryLayout("library_path_invalid", "A saved Fetch folder is invalid.")
			}
			return target.FetchPool + "/" + rest, nil
		}
		for _, name := range target.Pools {
			if strings.HasPrefix(strings.ToLower(root), strings.ToLower(name)+"/") {
				return root, nil
			}
		}
		if target.FetchPool == "" {
			return "", invalidLibraryLayout("fetch_pool_required", "Choose a Fetch pool for works currently outside the selected pools.")
		}
		return target.FetchPool + "/" + root, nil
	}
	pool, rest, ok := current.poolOf(root)
	if !ok || pool.Path == "" || rest == "" {
		return "", invalidLibraryLayout("library_path_outside_pool", "A saved work is outside the registered storage pools.")
	}
	return rest, nil
}

func (s *Server) libraryMigrationRoots(ctx context.Context) ([]string, map[string]bool, error) {
	fetchRoots := map[string]bool{}
	fetchRows, err := s.db.QueryContext(ctx, `
		SELECT root_path FROM work_folder_location WHERE role = 'managed_fetch'
		UNION SELECT target_root FROM remote_fetch_manifest
	`)
	if err != nil {
		return nil, nil, err
	}
	for fetchRows.Next() {
		var root string
		if err := fetchRows.Scan(&root); err != nil {
			_ = fetchRows.Close()
			return nil, nil, err
		}
		fetchRoots[root] = true
	}
	if err := fetchRows.Err(); err != nil {
		_ = fetchRows.Close()
		return nil, nil, err
	}
	_ = fetchRows.Close()
	rows, err := s.db.QueryContext(ctx, `
		SELECT root_path FROM work_folder_location
		UNION SELECT source_url FROM work_source_presence WHERE presence_type = 'local' AND source_url != ''
		UNION SELECT target_root FROM remote_fetch_manifest
	`)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	roots := []string{}
	for rows.Next() {
		var root string
		if err := rows.Scan(&root); err != nil {
			return nil, nil, err
		}
		roots = append(roots, root)
	}
	return roots, fetchRoots, rows.Err()
}

func (s *Server) addMigrationMove(plan *layoutMigrationPlan, from, to string) error {
	if !validMigrationPath(from) || !validMigrationPath(to) || from == to || strings.HasPrefix(to, from+"/") {
		return invalidLibraryLayout("library_path_invalid", "A library folder cannot be moved into itself.")
	}
	for _, move := range plan.Moves {
		if from == move.From || strings.HasPrefix(from, move.From+"/") || strings.HasPrefix(move.From, from+"/") || to == move.To {
			return invalidLibraryLayout("library_path_conflict", "Two library folders would overlap after the storage change.")
		}
	}
	source := filepath.Join(s.cfg.DataRoot, filepath.FromSlash(from))
	destination := filepath.Join(s.cfg.DataRoot, filepath.FromSlash(to))
	if err := rejectLinkedMigrationAncestors(s.cfg.DataRoot, from); err != nil {
		return err
	}
	if err := rejectLinkedMigrationAncestors(s.cfg.DataRoot, to); err != nil {
		return err
	}
	info, err := os.Lstat(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&fs.ModeSymlink != 0 {
		return invalidLibraryLayout("library_path_invalid", "A saved library folder is unavailable or linked.")
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return invalidLibraryLayout("library_path_conflict", "A target library folder already exists.")
	}
	bytes, err := migrationTreeBytes(source)
	if err != nil {
		return err
	}
	plan.Moves = append(plan.Moves, layoutMigrationMove{From: from, To: to, Bytes: bytes})
	plan.Bytes += bytes
	return nil
}

func migrationTreeBytes(root string) (int64, error) {
	var bytes int64
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := os.Lstat(name)
		if err != nil {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("library migration contains a linked or special file")
		}
		if info.Mode().IsRegular() {
			bytes += info.Size()
		}
		return nil
	})
	return bytes, err
}

func (s *Server) addTransactionMigrationMoves(ctx context.Context, plan *layoutMigrationPlan) error {
	for _, pool := range plan.Current.Pools {
		for _, transaction := range []string{".kikoto-staging", ".kikoto-backup", ".kikoto-trash/fetch"} {
			base := filepath.Join(s.cfg.DataRoot, pool.Path, filepath.FromSlash(transaction))
			entries, err := os.ReadDir(base)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				return err
			}
			for _, entry := range entries {
				if !entry.IsDir() {
					return invalidLibraryLayout("transaction_unresolved", "A Fetch transaction entry needs manual review before switching modes.")
				}
				runID, err := strconv.ParseInt(entry.Name(), 10, 64)
				if err != nil {
					return invalidLibraryLayout("transaction_unresolved", "A Fetch transaction entry needs manual review before switching modes.")
				}
				var target string
				if err := s.db.QueryRowContext(ctx, `SELECT target_root FROM remote_fetch_manifest WHERE workflow_run_id = ?`, runID).Scan(&target); err != nil {
					return invalidLibraryLayout("transaction_unresolved", "A Fetch transaction has no saved target and needs manual review.")
				}
				newTarget, err := rebaseLibraryRoot(plan.Current, plan.Requested, target, true)
				if err != nil {
					return err
				}
				newPool := ""
				if plan.Requested.Mode == storagepool.ModePools {
					newPool, _ = storagepool.Split(storagepool.ModePools, newTarget)
				}
				from := storagepool.Join(pool.Path, path.Join(transaction, entry.Name()))
				to := storagepool.Join(newPool, path.Join(transaction, entry.Name()))
				if from == to {
					continue
				}
				plan.Paths = append(plan.Paths, layoutMigrationMove{From: from, To: to})
				if err := s.addMigrationMove(plan, from, to); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// A failed Fetch may have a saved path without a current staging directory.
// Rewrite that manifest too so an explicit retry uses the new pool layout.
func (s *Server) addManifestMigrationPaths(ctx context.Context, plan *layoutMigrationPlan) error {
	rows, err := s.db.QueryContext(ctx, `SELECT workflow_run_id, target_root, staging_root, backup_root FROM remote_fetch_manifest`)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var runID int64
		var target, staging, backup string
		if err := rows.Scan(&runID, &target, &staging, &backup); err != nil {
			return err
		}
		newTarget, err := rebaseLibraryRoot(plan.Current, plan.Requested, target, true)
		if err != nil {
			return err
		}
		newPool := ""
		if plan.Requested.Mode == storagepool.ModePools {
			newPool, _ = storagepool.Split(storagepool.ModePools, newTarget)
		}
		oldPool, _ := storagepool.Split(plan.Current.effectiveMode(), target)
		for _, item := range []struct{ name, saved string }{{".kikoto-staging", staging}, {".kikoto-backup", backup}} {
			if item.saved == "" {
				continue
			}
			oldPrefix := storagepool.Join(oldPool, path.Join(item.name, strconv.FormatInt(runID, 10)))
			newPrefix := storagepool.Join(newPool, path.Join(item.name, strconv.FormatInt(runID, 10)))
			if item.saved != oldPrefix && !strings.HasPrefix(item.saved, oldPrefix+"/") {
				return invalidLibraryLayout("transaction_unresolved", "A saved Fetch transaction path needs manual review before switching modes.")
			}
			if oldPrefix != newPrefix {
				plan.Paths = append(plan.Paths, layoutMigrationMove{From: oldPrefix, To: newPrefix})
			}
		}
		oldTrash := storagepool.Join(oldPool, path.Join(".kikoto-trash/fetch", strconv.FormatInt(runID, 10)))
		newTrash := storagepool.Join(newPool, path.Join(".kikoto-trash/fetch", strconv.FormatInt(runID, 10)))
		if oldTrash != newTrash {
			plan.Paths = append(plan.Paths, layoutMigrationMove{From: oldTrash, To: newTrash})
		}
	}
	return rows.Err()
}
