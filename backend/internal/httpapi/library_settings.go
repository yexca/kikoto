package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

const (
	settingLibraryOnboardingCompleted = "library_onboarding_completed"
	// settingLibraryOnboardingTriggers records that a fresh install turned
	// its automatic local scan triggers off, so it happens only once.
	settingLibraryOnboardingTriggers = "library_onboarding_triggers_disabled"
)

type libraryPoolResponse struct {
	Path   string `json:"path"`
	Online bool   `json:"online"`
	Reason string `json:"reason,omitempty"`
	// CanReconnect reports that the pool directory exists but lacks its
	// marker, so an operator who confirmed the disk can mark it again.
	CanReconnect bool `json:"canReconnect"`
}

type libraryLayoutResponse struct {
	Mode                string                `json:"mode"`
	Configured          bool                  `json:"configured"`
	Locked              bool                  `json:"locked"`
	OnboardingCompleted bool                  `json:"onboardingCompleted"`
	Pools               []libraryPoolResponse `json:"pools"`
	Candidates          []string              `json:"candidates"`
	FetchPool           string                `json:"fetchPool"`
	LocalScanTriggers   libraryScanTriggers   `json:"localScanTriggers"`
}

type libraryScanTriggers struct {
	StartupScan  bool `json:"startupScan"`
	WatchFolders bool `json:"watchFolders"`
}

type libraryLayoutUpdate struct {
	Mode      string   `json:"mode"`
	Pools     []string `json:"pools"`
	FetchPool string   `json:"fetchPool"`
}

type libraryPoolReconnect struct {
	Path string `json:"path"`
}

type libraryOnboardingCompletion struct {
	StartupScan  bool `json:"startupScan"`
	WatchFolders bool `json:"watchFolders"`
}

// PrepareLibraryLayout settles the library mode at startup. An instance that
// already ran an earlier release, or already holds local works, keeps the
// standard layout it has always used and skips onboarding. A fresh install
// stays unconfigured until onboarding, and its automatic local scans start
// off: scanning before the library is set up would read the wrong layout.
func (s *Server) PrepareLibraryLayout(ctx context.Context) error {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil || layout.configured() {
		return err
	}
	upgraded, err := s.instanceRanEarlierRelease(ctx)
	if err != nil {
		return err
	}
	if !upgraded {
		if upgraded, err = s.libraryHasLocalWorks(ctx); err != nil {
			return err
		}
	}
	if upgraded {
		slog.Info("library uses the standard layout of an earlier release")
		if err := s.saveSettingValue(ctx, settingLibraryMode, storagepool.ModeStandard); err != nil {
			return err
		}
		return s.saveSettingValue(ctx, settingLibraryOnboardingCompleted, true)
	}
	if s.settingBoolContext(ctx, settingLibraryOnboardingTriggers, false) {
		return nil
	}
	if err := s.setLocalScanTriggers(ctx, libraryScanTriggers{}); err != nil {
		return err
	}
	return s.saveSettingValue(ctx, settingLibraryOnboardingTriggers, true)
}

// instanceRanEarlierRelease reads the release recorded by the previous
// successful start. It must run before this start records its own.
func (s *Server) instanceRanEarlierRelease(ctx context.Context) (bool, error) {
	var version string
	err := s.db.QueryRowContext(ctx, "SELECT last_successful_app_version FROM schema_state WHERE id = 1").Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return strings.TrimSpace(version) != "", err
}

func (s *Server) setLocalScanTriggers(ctx context.Context, triggers libraryScanTriggers) error {
	for _, item := range []struct {
		triggerType string
		enabled     bool
	}{{"startup", triggers.StartupScan}, {"filesystem_event", triggers.WatchFolders}} {
		if _, err := s.db.ExecContext(ctx, `
			UPDATE workflow_trigger SET enabled = ?, updated_at = CURRENT_TIMESTAMP
			WHERE trigger_type = ? AND workflow_definition_id IN (
				SELECT id FROM workflow_definition WHERE code = 'local_library_scan'
			)
		`, item.enabled, item.triggerType); err != nil {
			return err
		}
	}
	s.notifyFilesystemTriggerConfigChanged()
	return nil
}

func (s *Server) localScanTriggers(ctx context.Context) (libraryScanTriggers, error) {
	triggers := libraryScanTriggers{}
	rows, err := s.db.QueryContext(ctx, `
		SELECT scan_trigger.trigger_type, scan_trigger.enabled
		FROM workflow_trigger AS scan_trigger
		INNER JOIN workflow_definition AS definition ON definition.id = scan_trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan' AND scan_trigger.trigger_type IN ('startup', 'filesystem_event')
	`)
	if err != nil {
		return triggers, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var triggerType string
		var enabled bool
		if err := rows.Scan(&triggerType, &enabled); err != nil {
			return triggers, err
		}
		if triggerType == "startup" {
			triggers.StartupScan = triggers.StartupScan || enabled
		} else {
			triggers.WatchFolders = triggers.WatchFolders || enabled
		}
	}
	return triggers, rows.Err()
}

func (s *Server) getLibraryLayout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	response, err := s.libraryLayoutResponse(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) libraryLayoutResponse(ctx context.Context) (libraryLayoutResponse, error) {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return libraryLayoutResponse{}, err
	}
	locked, err := s.libraryHasLocalWorks(ctx)
	if err != nil {
		return libraryLayoutResponse{}, err
	}
	triggers, err := s.localScanTriggers(ctx)
	if err != nil {
		return libraryLayoutResponse{}, err
	}
	response := libraryLayoutResponse{
		Mode: layout.Mode, Configured: layout.configured(), Locked: locked && layout.configured(),
		OnboardingCompleted: s.settingBoolContext(ctx, settingLibraryOnboardingCompleted, false),
		Pools:               []libraryPoolResponse{}, Candidates: []string{}, FetchPool: layout.FetchPool,
		LocalScanTriggers: triggers,
	}
	if layout.configured() {
		states, err := s.libraryPoolStates(ctx, s.cfg.DataRoot, layout)
		if err != nil {
			return libraryLayoutResponse{}, err
		}
		for _, state := range states {
			response.Pools = append(response.Pools, libraryPoolResponse{
				Path: state.Pool.Path, Online: state.Online, Reason: state.Reason,
				CanReconnect: !state.Online && state.Reason == storagepool.ReasonMarkerMissing,
			})
		}
	}
	if !layout.configured() || layout.poolsMode() {
		candidates, err := storagepool.CandidateDirectories(s.cfg.DataRoot)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return libraryLayoutResponse{}, err
		}
		for _, name := range candidates {
			if _, registered := layout.pool(name); !registered || !layout.poolsMode() {
				response.Candidates = append(response.Candidates, name)
			}
		}
	}
	return response, nil
}

func (s *Server) updateLibraryLayout(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "demo_read_only", "Demo mode cannot change the library", false)
		return
	}
	var payload libraryLayoutUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := s.applyLibraryLayoutUpdate(r.Context(), payload); err != nil {
		var layoutErr libraryLayoutError
		if errors.As(err, &layoutErr) {
			writeAPIError(w, layoutErr.status, layoutErr.code, layoutErr.message, false)
			return
		}
		writeError(w, err)
		return
	}
	s.notifyFilesystemTriggerConfigChanged()
	response, err := s.libraryLayoutResponse(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

type libraryLayoutError struct {
	status  int
	code    string
	message string
}

func (err libraryLayoutError) Error() string { return err.message }

func invalidLibraryLayout(code string, message string) error {
	return libraryLayoutError{status: http.StatusBadRequest, code: code, message: message}
}

func (s *Server) applyLibraryLayoutUpdate(ctx context.Context, payload libraryLayoutUpdate) error {
	current, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return err
	}
	mode := strings.TrimSpace(payload.Mode)
	if mode != storagepool.ModeStandard && mode != storagepool.ModePools {
		return invalidLibraryLayout("library_mode_invalid", "Choose the standard or the storage pool library mode.")
	}
	hasWorks, err := s.libraryHasLocalWorks(ctx)
	if err != nil {
		return err
	}
	if current.configured() && hasWorks && mode != current.Mode {
		return libraryLayoutError{status: http.StatusConflict, code: "library_mode_locked",
			message: "The library mode cannot change after local works were found."}
	}
	if mode == storagepool.ModeStandard {
		return s.saveSettingValue(ctx, settingLibraryMode, storagepool.ModeStandard)
	}
	pools, err := s.registerStoragePools(ctx, current, payload.Pools)
	if err != nil {
		return err
	}
	fetchPool := strings.TrimSpace(payload.FetchPool)
	if fetchPool != "" {
		found := false
		for _, pool := range pools {
			found = found || pool.Path == fetchPool
		}
		if !found {
			return invalidLibraryLayout("fetch_pool_invalid", "The Fetch pool must be one of the storage pools.")
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for key, value := range map[string]any{settingLibraryMode: storagepool.ModePools, settingStoragePools: pools, settingFetchPool: fetchPool} {
		if err := saveSettingValueTx(ctx, tx, key, value); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// registerStoragePools validates the requested pools. A newly registered pool
// must be a first-level directory where files can be renamed; it receives a
// marker, or keeps the marker it already carries from an earlier
// registration. A pool that still holds local works cannot be removed.
func (s *Server) registerStoragePools(ctx context.Context, current libraryLayout, requested []string) ([]storagepool.Pool, error) {
	seen := map[string]bool{}
	names := []string{}
	for _, name := range requested {
		name = strings.TrimSpace(name)
		if !storagepool.ValidName(name) {
			return nil, invalidLibraryLayout("storage_pool_invalid", "A storage pool must be a visible first-level folder of the data directory.")
		}
		if !seen[strings.ToLower(name)] {
			seen[strings.ToLower(name)] = true
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return nil, invalidLibraryLayout("storage_pool_required", "Choose at least one storage pool.")
	}
	sort.Strings(names)
	if current.poolsMode() {
		for _, pool := range current.Pools {
			if seen[strings.ToLower(pool.Path)] {
				continue
			}
			inUse, err := s.storagePoolHasLocalWorks(ctx, pool.Path)
			if err != nil {
				return nil, err
			}
			if inUse {
				return nil, libraryLayoutError{status: http.StatusConflict, code: "storage_pool_in_use",
					message: "A storage pool that holds local works cannot be removed."}
			}
		}
	}
	pools := make([]storagepool.Pool, 0, len(names))
	for _, name := range names {
		if existing, ok := current.pool(name); ok && current.poolsMode() {
			pools = append(pools, existing)
			continue
		}
		pool, err := s.registerStoragePool(name)
		if err != nil {
			return nil, err
		}
		pools = append(pools, pool)
	}
	return pools, nil
}

func (s *Server) registerStoragePool(name string) (storagepool.Pool, error) {
	root := storagepool.Root(s.cfg.DataRoot, storagepool.Pool{Path: name})
	if !storagepool.IsDirectory(root) {
		return storagepool.Pool{}, invalidLibraryLayout("storage_pool_missing", "The storage pool folder "+name+" does not exist in the data directory or is a link.")
	}
	if err := storagepool.ProbeRename(root); err != nil {
		slog.Warn("storage pool rename probe failed", "pool", name, "error", err)
		return storagepool.Pool{}, invalidLibraryLayout("storage_pool_not_writable", "Kikoto cannot create and rename files in "+name+". Check the mount and its permissions.")
	}
	id, exists, err := storagepool.ReadMarker(root)
	if err != nil {
		return storagepool.Pool{}, invalidLibraryLayout("storage_pool_marker_invalid", "The storage pool marker in "+name+" is invalid. Remove it and register the folder again.")
	}
	if !exists {
		if id, err = storagepool.NewID(); err != nil {
			return storagepool.Pool{}, err
		}
		if err := storagepool.WriteMarker(root, id); err != nil {
			return storagepool.Pool{}, err
		}
	}
	return storagepool.Pool{Path: name, ID: id}, nil
}

func (s *Server) storagePoolHasLocalWorks(ctx context.Context, poolPath string) (bool, error) {
	prefix := poolPath + "/"
	var exists bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM work_source_presence AS presence
			INNER JOIN file_source AS source ON source.id = presence.file_source_id
			WHERE source.source_type = 'local_folder' AND presence.presence_type = 'local'
				AND substr(presence.source_url, 1, length(?)) = ?
		) OR EXISTS (
			SELECT 1 FROM work_folder_location AS folder
			INNER JOIN file_source AS source ON source.id = folder.file_source_id
			WHERE source.source_type = 'local_folder' AND substr(folder.root_path, 1, length(?)) = ?
		)
	`, prefix, prefix, prefix, prefix).Scan(&exists)
	return exists, err
}

// reconnectLibraryPool marks a pool directory again after the operator
// confirmed that the right disk is mounted there, for example after the
// marker was removed by hand or the library was restored from a backup.
func (s *Server) reconnectLibraryPool(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var payload libraryPoolReconnect
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	layout, err := s.loadLibraryLayout(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	pool, ok := layout.pool(strings.TrimSpace(payload.Path))
	if !layout.configured() || !ok {
		writeAPIError(w, http.StatusNotFound, "storage_pool_not_found", "This storage pool is not registered.", false)
		return
	}
	root := storagepool.Root(s.cfg.DataRoot, pool)
	if online, reason := storagepool.Check(s.cfg.DataRoot, pool, pool.ID); online || reason != storagepool.ReasonMarkerMissing {
		writeAPIError(w, http.StatusConflict, "storage_pool_not_reconnectable", "Only an existing pool folder without its marker can be reconnected.", false)
		return
	}
	id := pool.ID
	if id == "" {
		if id, err = storagepool.NewID(); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := storagepool.WriteMarker(root, id); err != nil {
		slog.Error("reconnect storage pool", "pool", pool.Path, "error", err)
		writeAPIError(w, http.StatusConflict, "storage_pool_not_writable", "Kikoto cannot write the pool marker. Check the mount and its permissions.", false)
		return
	}
	if !layout.poolsMode() {
		if err := s.saveSettingValue(r.Context(), settingStandardPoolID, id); err != nil {
			writeError(w, err)
			return
		}
	}
	s.notifyFilesystemTriggerConfigChanged()
	response, err := s.libraryLayoutResponse(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) completeLibraryOnboarding(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var payload libraryOnboardingCompletion
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	layout, err := s.loadLibraryLayout(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if !layout.configured() {
		writeAPIError(w, http.StatusConflict, "library_not_configured", "Choose a library mode before finishing setup.", false)
		return
	}
	if err := s.setLocalScanTriggers(r.Context(), libraryScanTriggers(payload)); err != nil {
		writeError(w, err)
		return
	}
	if err := s.saveSettingValue(r.Context(), settingLibraryOnboardingCompleted, true); err != nil {
		writeError(w, err)
		return
	}
	response, err := s.libraryLayoutResponse(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}
