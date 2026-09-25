package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// Library layout settings. The mode is chosen once, during onboarding or
// automatically for an instance upgraded from an earlier release, and is
// locked once the library holds local works.
const (
	settingLibraryMode    = "library_mode"
	settingStoragePools   = "storage_pools"
	settingFetchPool      = "fetch_pool"
	settingStandardPoolID = "library_pool_id"
)

// libraryLayout is the configured storage layout. Mode is empty until the
// library is configured; execution then treats the data root as the standard
// pool so existing behavior is unchanged.
type libraryLayout struct {
	Mode      string
	Pools     []storagepool.Pool
	FetchPool string
}

func (layout libraryLayout) configured() bool {
	return layout.Mode == storagepool.ModeStandard || layout.Mode == storagepool.ModePools
}

func (layout libraryLayout) poolsMode() bool {
	return layout.Mode == storagepool.ModePools
}

// effectiveMode is the mode paths are interpreted in.
func (layout libraryLayout) effectiveMode() string {
	if layout.poolsMode() {
		return storagepool.ModePools
	}
	return storagepool.ModeStandard
}

func (layout libraryLayout) pool(path string) (storagepool.Pool, bool) {
	for _, pool := range layout.Pools {
		if strings.EqualFold(pool.Path, path) {
			return pool, true
		}
	}
	return storagepool.Pool{}, false
}

// poolOf returns the pool that holds rel, a path relative to the data root.
func (layout libraryLayout) poolOf(rel string) (storagepool.Pool, string, bool) {
	poolPath, rest := storagepool.Split(layout.effectiveMode(), rel)
	pool, ok := layout.pool(poolPath)
	return pool, rest, ok
}

type libraryPoolState struct {
	Pool   storagepool.Pool
	Online bool
	Reason string
}

func (s *Server) loadLibraryLayout(ctx context.Context) (libraryLayout, error) {
	values := map[string]string{}
	rows, err := s.db.QueryContext(ctx, `
		SELECT key, value_json FROM app_setting WHERE key IN (?, ?, ?, ?)
	`, settingLibraryMode, settingStoragePools, settingFetchPool, settingStandardPoolID)
	if err != nil {
		return libraryLayout{}, err
	}
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			_ = rows.Close()
			return libraryLayout{}, err
		}
		values[key] = raw
	}
	if err := rows.Close(); err != nil {
		return libraryLayout{}, err
	}
	decodeString := func(key string) string {
		var value string
		_ = json.Unmarshal([]byte(values[key]), &value)
		return strings.TrimSpace(value)
	}
	layout := libraryLayout{Mode: decodeString(settingLibraryMode)}
	if layout.poolsMode() {
		pools := []storagepool.Pool{}
		if raw := values[settingStoragePools]; raw != "" {
			if err := json.Unmarshal([]byte(raw), &pools); err != nil {
				return libraryLayout{}, fmt.Errorf("decode storage pools: %w", err)
			}
		}
		for _, pool := range pools {
			if storagepool.ValidName(pool.Path) && pool.ID != "" {
				layout.Pools = append(layout.Pools, pool)
			}
		}
		layout.FetchPool = decodeString(settingFetchPool)
		return layout, nil
	}
	if layout.Mode != storagepool.ModeStandard {
		layout.Mode = ""
	}
	layout.Pools = []storagepool.Pool{{Path: "", ID: decodeString(settingStandardPoolID)}}
	return layout, nil
}

// libraryPoolStates reports which pools can be read now. The standard pool
// adopts an unmarked data root that visibly holds media, or that is empty for
// a library without local works; an empty root of a library that has local
// works stays offline, because that is what an unmounted volume looks like.
func (s *Server) libraryPoolStates(ctx context.Context, root string, layout libraryLayout) ([]libraryPoolState, error) {
	if layout.poolsMode() {
		states := make([]libraryPoolState, 0, len(layout.Pools))
		for _, pool := range layout.Pools {
			online, reason := storagepool.Check(root, pool, pool.ID)
			states = append(states, libraryPoolState{Pool: pool, Online: online, Reason: reason})
		}
		return states, nil
	}
	pool := layout.Pools[0]
	online, reason, err := s.ensureStandardPoolMarker(ctx, root, pool)
	if err != nil {
		return nil, err
	}
	return []libraryPoolState{{Pool: pool, Online: online, Reason: reason}}, nil
}

func (s *Server) ensureStandardPoolMarker(ctx context.Context, root string, pool storagepool.Pool) (bool, string, error) {
	online, reason := storagepool.Check(root, pool, "")
	if online || reason != storagepool.ReasonMarkerMissing {
		return online, reason, nil
	}
	visible, err := storagepool.HasVisibleEntries(root)
	if err != nil {
		return false, storagepool.ReasonUnreadable, nil
	}
	if !visible {
		hasLocalWorks, err := s.libraryHasLocalWorks(ctx)
		if err != nil {
			return false, "", err
		}
		if hasLocalWorks {
			return false, storagepool.ReasonMarkerMissing, nil
		}
	}
	id := pool.ID
	if id == "" {
		if id, err = storagepool.NewID(); err != nil {
			return false, "", err
		}
	}
	if err := storagepool.WriteMarker(root, id); err != nil {
		// A read-only library can still be scanned; only an empty-looking
		// root needs the marker to be told apart from an unmounted one.
		slog.Warn("write library marker", "error", err)
		return visible, storagepool.ReasonMarkerMissing, nil
	}
	if err := s.saveSettingValue(ctx, settingStandardPoolID, id); err != nil {
		return false, "", err
	}
	return true, "", nil
}

// libraryHasLocalWorks reports whether any work has been seen in the local
// library, whatever its current availability.
func (s *Server) libraryHasLocalWorks(ctx context.Context) (bool, error) {
	var exists bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM work_source_presence AS presence
			INNER JOIN file_source AS source ON source.id = presence.file_source_id
			WHERE source.source_type = 'local_folder' AND presence.presence_type = 'local'
		) OR EXISTS (
			SELECT 1 FROM work_folder_location AS folder
			INNER JOIN file_source AS source ON source.id = folder.file_source_id
			WHERE source.source_type = 'local_folder'
		)
	`).Scan(&exists)
	return exists, err
}

func (s *Server) saveSettingValue(ctx context.Context, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO app_setting (key, value_json) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
	`, key, string(encoded))
	return err
}

func saveSettingValueTx(ctx context.Context, tx *sql.Tx, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO app_setting (key, value_json) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
	`, key, string(encoded))
	return err
}

// localScanScope is the part of the library one scan can observe: the online
// pools, up to the scan depth inside each. A scan only changes the state of
// works whose recorded roots lie inside its scope. A work in an offline pool,
// or deeper than the scan reaches, keeps its previous state.
type localScanScope struct {
	mode    string
	online  []string
	offline []libraryPoolState
	depth   int
}

func (s *Server) localScanScope(ctx context.Context, root string, depth int) (localScanScope, error) {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return localScanScope{}, err
	}
	states, err := s.libraryPoolStates(ctx, root, layout)
	if err != nil {
		return localScanScope{}, err
	}
	scope := localScanScope{mode: layout.effectiveMode(), depth: depth}
	for _, state := range states {
		if state.Online {
			scope.online = append(scope.online, state.Pool.Path)
		} else {
			scope.offline = append(scope.offline, state)
		}
	}
	return scope, nil
}

func (scope localScanScope) poolsMode() bool {
	return scope.mode == storagepool.ModePools
}

// walkDepth is the scan depth measured from the data root.
func (scope localScanScope) walkDepth() int {
	if scope.poolsMode() {
		return scope.depth + 1
	}
	return scope.depth
}

func (scope localScanScope) subRoots() []string {
	if scope.poolsMode() {
		return scope.online
	}
	return nil
}

func (scope localScanScope) poolOnline(poolPath string) bool {
	for _, online := range scope.online {
		if strings.EqualFold(online, poolPath) {
			return true
		}
	}
	return false
}

// contains reports whether a work root, relative to the data root, can be
// observed by this scan.
func (scope localScanScope) contains(rel string) bool {
	poolPath, rest := storagepool.Split(scope.mode, rel)
	if !scope.poolOnline(poolPath) {
		return false
	}
	depth := storagepool.Depth(rest)
	return depth >= 1 && depth <= scope.depth
}

// filterChangedPaths keeps changed paths inside online pools.
func (scope localScanScope) filterChangedPaths(paths []string) []string {
	if !scope.poolsMode() {
		return paths
	}
	kept := []string{}
	for _, changed := range paths {
		poolPath, rest := storagepool.Split(scope.mode, changed)
		if rest != "" && scope.poolOnline(poolPath) {
			kept = append(kept, changed)
		}
	}
	return kept
}

// filterKnownRoots keeps known work roots this scan can observe, so a change
// event can never mark a work outside its reach missing.
func (scope localScanScope) filterKnownRoots(roots []knownLocalWorkRoot) []knownLocalWorkRoot {
	kept := roots[:0]
	for _, root := range roots {
		if scope.contains(root.Root) {
			kept = append(kept, root)
		}
	}
	return kept
}

// applyOfflineResult makes a scan that skipped offline pools partial, so the
// skipped pools appear in Activity instead of passing silently.
func (scope localScanScope) applyOfflineResult(result *localScanResult) {
	if len(scope.offline) == 0 {
		return
	}
	result.Status = "partial"
	result.Failures = append(result.Failures, scope.offlineFailures()...)
}

func (scope localScanScope) offlinePoolSummaries() []map[string]string {
	summaries := make([]map[string]string, 0, len(scope.offline))
	for _, state := range scope.offline {
		summaries = append(summaries, map[string]string{"pool": state.Pool.Path, "reason": state.Reason})
	}
	return summaries
}

func (scope localScanScope) offlineFailures() []string {
	failures := make([]string, 0, len(scope.offline))
	for _, state := range scope.offline {
		if state.Pool.Path == "" {
			failures = append(failures, "The library folder is unavailable; its works were left unchanged. Check that the data directory is mounted.")
			continue
		}
		failures = append(failures, fmt.Sprintf("Storage pool %q is offline; its works were left unchanged.", state.Pool.Path))
	}
	return failures
}

var errLibraryUnavailable = errors.New("the library folder is unavailable; no works were marked missing. Check that the data directory is mounted, then run the scan again")

// filterLocalScanFolders keeps discovered folders inside the scope. In pool
// mode this drops a pool directory itself and anything outside a pool.
func (scope localScanScope) filterFolders(folders []localfs.WorkFolder) []localfs.WorkFolder {
	kept := folders[:0]
	for _, folder := range folders {
		if scope.contains(folder.RelPath) {
			kept = append(kept, folder)
		}
	}
	return kept
}
