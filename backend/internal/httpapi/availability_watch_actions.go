package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
)

// remoteBulkMaxWorks bounds the works one Availability Watch Track or Fetch
// request queues; the rest wait for the next request.
const remoteBulkMaxWorks = 100

type availabilityWatchActionRequest struct {
	TargetIDs []int64 `json:"targetIds"`
	// ExcludeExtensions leaves files with these extensions out of a Fetch.
	ExcludeExtensions []string `json:"excludeExtensions"`
}

type availabilityWatchActionResult struct {
	// Runs are the bulk runs queued, one per remote source.
	Runs []remoteBulkWorkflowResult `json:"runs"`
	// Queued lists the targets a run now acts for; Skipped counts listed
	// targets that are not available or already have the action running.
	Queued  []int64 `json:"queued"`
	Skipped int     `json:"skipped"`
}

type availabilityWatchActionTarget struct {
	id       int64
	code     string
	sourceID int64
}

// trackAvailabilityWatchTargets tracks the listed available targets through
// the remote bulk path, each from the source that offered it.
func (s *Server) trackAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request) {
	s.actOnAvailabilityWatchTargets(w, r, "track")
}

// fetchAvailabilityWatchTargets fetches the listed available targets through
// the remote bulk path, leaving out the extensions the request excludes.
func (s *Server) fetchAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request) {
	s.actOnAvailabilityWatchTargets(w, r, "fetch")
}

func (s *Server) actOnAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request, action string) {
	actor, ok := s.requirePermissions(w, r, append([]string{"workflows:run"}, remoteBulkActionPermissions(action)...)...)
	if !ok {
		return
	}
	var payload availabilityWatchActionRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if len(payload.TargetIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "targetIds are required"})
		return
	}
	if err := validateAvailabilityWatchTargetIDs(payload.TargetIDs, remoteBulkMaxWorks); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	excluded := []string{}
	if action == "fetch" {
		excluded = normalizeExtensionList(payload.ExcludeExtensions)
	}
	result, err := s.queueAvailabilityWatchAction(r.Context(), actor.ID, action, payload.TargetIDs, excluded)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// queueAvailabilityWatchAction queues one remote bulk run per source for the
// listed targets that are available and have no run of the action in
// progress. Each target references the bulk run until the run starts the
// target's own Track or Fetch.
func (s *Server) queueAvailabilityWatchAction(ctx context.Context, userID int64, action string, targetIDs []int64, excluded []string) (availabilityWatchActionResult, error) {
	column := availabilityWatchRunColumn(action)
	rows, err := s.db.QueryContext(ctx, `
		SELECT target.id, COALESCE(NULLIF(target.available_code, ''), target.work_code), target.available_source_id
		FROM availability_watch_target AS target
		LEFT JOIN workflow_run AS run ON run.id = target.`+column+`
		WHERE target.watch_id = ? AND target.active = 1 AND target.state = 'ready'
			AND target.available_source_id IS NOT NULL
			AND COALESCE(run.status, '') NOT IN ('queued', 'running')
			AND target.id IN (SELECT value FROM json_each(?))
		ORDER BY target.id
	`, availabilityWatchID, mustJSON(targetIDs))
	if err != nil {
		return availabilityWatchActionResult{}, err
	}
	bySource := map[int64][]availabilityWatchActionTarget{}
	sources := []int64{}
	for rows.Next() {
		var target availabilityWatchActionTarget
		if err := rows.Scan(&target.id, &target.code, &target.sourceID); err != nil {
			_ = rows.Close()
			return availabilityWatchActionResult{}, err
		}
		if _, seen := bySource[target.sourceID]; !seen {
			sources = append(sources, target.sourceID)
		}
		bySource[target.sourceID] = append(bySource[target.sourceID], target)
	}
	if err := rows.Close(); err != nil {
		return availabilityWatchActionResult{}, err
	}
	result := availabilityWatchActionResult{Runs: []remoteBulkWorkflowResult{}, Queued: []int64{}}
	for _, sourceID := range sources {
		targets := bySource[sourceID]
		payload := remoteBulkActionJobPayload{UserID: userID, SourceID: sourceID, Action: action, ExcludeExtensions: excluded, WatchTargets: map[string]int64{}}
		ids := make([]int64, 0, len(targets))
		for _, target := range targets {
			// Two targets of one family can offer the same edition; it is
			// tracked or fetched once, for the first of them.
			if _, seen := payload.WatchTargets[target.code]; seen {
				continue
			}
			payload.Codes = append(payload.Codes, target.code)
			payload.WatchTargets[target.code] = target.id
			ids = append(ids, target.id)
		}
		run, err := s.enqueueRemoteBulkWorkflowWith(ctx, payload, func(tx *sql.Tx, runID int64) error {
			_, err := tx.ExecContext(ctx, `
				UPDATE availability_watch_target
				SET `+column+` = ?, last_error = '', updated_at = CURRENT_TIMESTAMP
				WHERE watch_id = ? AND active = 1 AND id IN (SELECT value FROM json_each(?))
			`, runID, availabilityWatchID, mustJSON(ids))
			return err
		})
		if err != nil {
			return result, err
		}
		result.Runs = append(result.Runs, run)
		result.Queued = append(result.Queued, ids...)
	}
	result.Skipped = len(targetIDs) - len(result.Queued)
	return result, nil
}

// availabilityWatchRunColumn names the target column that references the
// action's run; it is never built from request input.
func availabilityWatchRunColumn(action string) string {
	if action == "track" {
		return "track_run_id"
	}
	return "fetch_run_id"
}

// recordAvailabilityWatchRun moves a target's reference from the bulk run to
// the Track or Fetch run it started, unless another request has replaced it.
func (s *Server) recordAvailabilityWatchRun(ctx context.Context, targetID int64, action string, bulkRunID, runID int64) {
	column := availabilityWatchRunColumn(action)
	s.execBestEffort(ctx, "record availability watch run", `
		UPDATE availability_watch_target
		SET `+column+` = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND `+column+` = ?
	`, runID, targetID, bulkRunID)
}

// recordAvailabilityWatchActionFailure keeps the target on the bulk run,
// whose record states the failure, and shows the reason on the target.
func (s *Server) recordAvailabilityWatchActionFailure(ctx context.Context, targetID int64, action string, bulkRunID int64) {
	column := availabilityWatchRunColumn(action)
	message := "Fetch could not be queued"
	if action == "track" {
		message = "Track failed"
	}
	s.execBestEffort(ctx, "record availability watch action failure", `
		UPDATE availability_watch_target
		SET last_error = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND `+column+` = ?
	`, message, targetID, bulkRunID)
}

// cleanUpAvailabilityWatchTargets removes the listed targets that the library
// has or whose Track or Fetch succeeded. A listed target that no longer
// qualifies stays, so the caller removes only what it showed.
func (s *Server) cleanUpAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request) {
	s.removeAvailabilityWatchTargetList(w, r, `AND (`+availabilityWatchInLibrarySQL+`
		OR EXISTS (SELECT 1 FROM workflow_run AS run WHERE run.id IN (target.track_run_id, target.fetch_run_id) AND run.status = 'succeeded'))`)
}

// removeAvailabilityWatchTargets removes the listed targets in one statement.
func (s *Server) removeAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request) {
	s.removeAvailabilityWatchTargetList(w, r, "")
}

func (s *Server) removeAvailabilityWatchTargetList(w http.ResponseWriter, r *http.Request, condition string) {
	if _, ok := s.requirePermissions(w, r, availabilityWatchPermissions...); !ok {
		return
	}
	var payload availabilityWatchTargetIDs
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := validateAvailabilityWatchTargetIDs(payload.TargetIDs, availabilityWatchMaxTargets); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(payload.TargetIDs) > 0 {
		if _, err := s.db.ExecContext(r.Context(), `
			UPDATE availability_watch_target AS target
			SET active = 0, state = 'disabled', next_check_at = NULL,
				revision = revision + 1, updated_at = CURRENT_TIMESTAMP
			WHERE watch_id = ? AND active = 1 AND id IN (SELECT value FROM json_each(?)) `+condition,
			availabilityWatchID, mustJSON(payload.TargetIDs)); err != nil {
			writeError(w, err)
			return
		}
	}
	s.writeAvailabilityWatchView(w, r)
}

// remoteFetchPathsExcluding lists a remote work's files without the excluded
// extensions; with nothing left there is nothing to fetch.
func (s *Server) remoteFetchPathsExcluding(ctx context.Context, sourceID int64, code string, excludedValues []string) ([]string, error) {
	_, _, tracks, err := s.loadRemoteWorkTracksCached(ctx, sourceID, code)
	if err != nil {
		return nil, err
	}
	excluded := map[string]bool{}
	for _, value := range normalizeExtensionList(excludedValues) {
		excluded[value] = true
	}
	paths := []string{}
	for _, file := range flattenRemoteSaveFiles(tracks) {
		extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(file.Path), "."))
		if !excluded[extension] {
			paths = append(paths, file.Path)
		}
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no files remain after extension filtering")
	}
	return paths, nil
}
