package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	availabilityWatchID          int64 = 1
	availabilityWatchDisplayName       = "Availability Watch"
	availabilityWatchDescription       = "Monitor a shared pool of work codes and report when a remote source offers one of them."
	// availabilityWatchMaxTargets bounds the shared pool and one request's
	// target list.
	availabilityWatchMaxTargets = 1000
)

var errAvailabilityWatchRunActive = errors.New("an Availability Watch run is already active")

// availabilityWatchPermissions are what changing or running the watch needs:
// every run refreshes the watched DLsite families before it checks the
// sources. The watch only monitors; a Track or Fetch of an available work
// checks its own remote permission.
var availabilityWatchPermissions = []string{"workflows:run", "metadata:sync"}

type availabilityWatchView struct {
	ID       int64                     `json:"id"`
	SourceID *int64                    `json:"sourceId"`
	Revision int                       `json:"revision"`
	Targets  []availabilityWatchTarget `json:"targets"`
}

type availabilityWatchTarget struct {
	ID                int64  `json:"id"`
	WorkCode          string `json:"workCode"`
	Title             string `json:"title"`
	CoverURL          string `json:"coverUrl"`
	State             string `json:"state"`
	NextCheckAt       string `json:"nextCheckAt"`
	LastCheckedAt     string `json:"lastCheckedAt"`
	LastStatus        string `json:"lastStatus"`
	LastError         string `json:"lastError"`
	AvailableSourceID *int64 `json:"availableSourceId"`
	// AvailableCode is the family edition a remote source offered.
	AvailableCode string `json:"availableCode"`
	TrackRunID    *int64 `json:"trackRunId"`
	FetchRunID    *int64 `json:"fetchRunId"`
	// TrackRunStatus and FetchRunStatus are the status of the referenced run,
	// empty when there is none.
	TrackRunStatus string `json:"trackRunStatus"`
	FetchRunStatus string `json:"fetchRunStatus"`
	// InLibrary is true when the watched code or the edition found has files:
	// local, cached, or a tracked remote work's stream or download, the same
	// rule as a ranking's in-library works.
	InLibrary bool `json:"inLibrary"`
	// AddedAt is when the code last entered the pool.
	AddedAt string `json:"addedAt"`
	// ReleaseDate is the watched code's release date when Kikoto knows it.
	ReleaseDate string                          `json:"releaseDate"`
	Family      []availabilityWatchFamilyMember `json:"family"`
}

type availabilityWatchConfigUpdate struct {
	SourceID *int64 `json:"sourceId"`
}

type availabilityWatchTargetsUpdate struct {
	TargetCodes []string `json:"targetCodes"`
}

type availabilityWatchRunResult struct {
	RunID               int64    `json:"runId"`
	JobID               int64    `json:"jobId"`
	Status              string   `json:"status"`
	TargetCount         int      `json:"targetCount"`
	Checked             int      `json:"checked"`
	Ready               int      `json:"ready"`
	NewlyAvailableCodes []string `json:"newlyAvailableCodes"`
	ReadyCodes          []string `json:"readyCodes"`
	Failures            []string `json:"failures"`
}

type availabilityWatchTargetSnapshot struct {
	ID       int64  `json:"id"`
	WorkCode string `json:"workCode"`
	State    string `json:"state"`
	Revision int    `json:"revision"`
}

type availabilityWatchJobPayload struct {
	RequestedByUserID int64                             `json:"requestedByUserId"`
	SourceID          int64                             `json:"sourceId"`
	Targets           []availabilityWatchTargetSnapshot `json:"targets"`
}

type availabilityWatchExecutionTarget struct {
	State             string
	Revision          int
	LastStatus        string
	Epoch             int
	AvailableSourceID int64
	AvailableCode     string
	Active            bool
}

type availabilityWatchExecution struct {
	result    availabilityWatchRunResult
	readySeen map[string]bool
	syncer    dlsiteFamilyMetadataSyncer
	metadata  availabilityWatchFamilyMetadata
}

type availabilityWatchTargetIDs struct {
	TargetIDs []int64 `json:"targetIds"`
}

func (s *Server) getAvailabilityWatch(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) updateAvailabilityWatch(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermissions(w, r, availabilityWatchPermissions...)
	if !ok {
		return
	}
	var payload availabilityWatchConfigUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := s.validateAvailabilityWatchSource(r.Context(), payload.SourceID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if payload.SourceID == nil || *payload.SourceID <= 0 {
		payload.SourceID = nil
	}
	if err := s.persistAvailabilityWatchConfig(r.Context(), actor.ID, payload); err != nil {
		writeError(w, err)
		return
	}
	s.writeAvailabilityWatchView(w, r)
}

func (s *Server) updateAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request) {
	s.writeAvailabilityWatchTargets(w, r, true)
}

// addAvailabilityWatchTargets adds codes to the shared pool without
// deactivating targets another user added meanwhile.
func (s *Server) addAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request) {
	s.writeAvailabilityWatchTargets(w, r, false)
}

func (s *Server) writeAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request, replace bool) {
	actor, ok := s.requirePermissions(w, r, availabilityWatchPermissions...)
	if !ok {
		return
	}
	var payload availabilityWatchTargetsUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	codes, err := normalizeGraphWorkCodes(payload.TargetCodes, availabilityWatchMaxTargets)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if !replace {
		var total int
		if err := s.db.QueryRowContext(r.Context(), `
			SELECT
				(SELECT COUNT(*) FROM availability_watch_target WHERE watch_id = ? AND active = 1)
				+ (SELECT COUNT(*) FROM json_each(?) AS code WHERE NOT EXISTS (
					SELECT 1 FROM availability_watch_target AS target
					WHERE target.watch_id = ? AND target.active = 1 AND target.work_code = code.value
				))
		`, availabilityWatchID, mustJSON(codes), availabilityWatchID).Scan(&total); err != nil {
			writeError(w, err)
			return
		}
		if total > availabilityWatchMaxTargets {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many work codes; maximum is 1000"})
			return
		}
	}
	if err := s.persistAvailabilityWatchTargets(r.Context(), actor.ID, codes, replace); err != nil {
		writeError(w, err)
		return
	}
	s.writeAvailabilityWatchView(w, r)
}

func (s *Server) deleteAvailabilityWatchTarget(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermissions(w, r, availabilityWatchPermissions...); !ok {
		return
	}
	targetID, err := parseInt64PathValue(r, "id")
	if err != nil || targetID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Availability Watch target id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		UPDATE availability_watch_target
		SET active = 0, state = 'disabled', next_check_at = NULL,
			revision = revision + 1, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND watch_id = ? AND active = 1
	`, targetID, availabilityWatchID)
	if err != nil {
		writeError(w, err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Availability Watch target not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// runAvailabilityWatch checks the whole pool, or only the listed targets, so
// a failed check can be retried without checking the pool again.
func (s *Server) runAvailabilityWatch(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermissions(w, r, availabilityWatchPermissions...)
	if !ok {
		return
	}
	var payload availabilityWatchTargetIDs
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := validateAvailabilityWatchTargetIDs(payload.TargetIDs, availabilityWatchMaxTargets); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if view.ID == 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "add works to Availability Watch before checking it"})
		return
	}
	trigger := workflowRunTrigger{Type: "manual", Reason: "manual_run"}
	if len(payload.TargetIDs) > 0 {
		trigger.Reason = "manual_target_check"
	}
	result, err := s.enqueueAvailabilityWatch(r.Context(), actor.ID, trigger, payload.TargetIDs...)
	if errors.Is(err, errAvailabilityWatchRunActive) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func validateAvailabilityWatchTargetIDs(ids []int64, limit int) error {
	if len(ids) > limit {
		return fmt.Errorf("too many target ids; maximum is %d", limit)
	}
	for _, id := range ids {
		if id <= 0 {
			return fmt.Errorf("invalid Availability Watch target id")
		}
	}
	return nil
}

func (s *Server) writeAvailabilityWatchView(w http.ResponseWriter, r *http.Request) {
	view, err := s.loadAvailabilityWatch(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) validateAvailabilityWatchSource(ctx context.Context, sourceID *int64) error {
	if sourceID == nil || *sourceID <= 0 {
		return nil
	}
	source, err := s.loadRemoteSourceForUse(ctx, *sourceID)
	if err != nil || !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		return fmt.Errorf("sourceId must identify an enabled compatible remote source")
	}
	return nil
}

func (s *Server) persistAvailabilityWatchConfig(ctx context.Context, userID int64, payload availabilityWatchConfigUpdate) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO availability_watch (id, configured_by_user_id, source_id)
		VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			configured_by_user_id = excluded.configured_by_user_id,
			source_id = excluded.source_id,
			revision = availability_watch.revision + 1,
			updated_at = CURRENT_TIMESTAMP
	`, availabilityWatchID, userID, payload.SourceID)
	return err
}

func (s *Server) persistAvailabilityWatchTargets(ctx context.Context, userID int64, codes []string, replace bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO availability_watch (id, configured_by_user_id)
		VALUES (?, ?)
		ON CONFLICT(id) DO NOTHING
	`, availabilityWatchID, userID); err != nil {
		return err
	}
	// A removed code that is added again starts over, with a new added time.
	for _, code := range codes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO availability_watch_target (watch_id, work_code, active, state, next_check_at)
			VALUES (?, ?, 1, 'monitoring', CURRENT_TIMESTAMP)
			ON CONFLICT(watch_id, work_code) DO UPDATE SET
				active = 1,
				state = CASE WHEN availability_watch_target.active = 0 THEN 'monitoring' ELSE availability_watch_target.state END,
				next_check_at = CASE WHEN availability_watch_target.active = 0 THEN CURRENT_TIMESTAMP ELSE availability_watch_target.next_check_at END,
				last_status = CASE WHEN availability_watch_target.active = 0 THEN '' ELSE availability_watch_target.last_status END,
				last_error = CASE WHEN availability_watch_target.active = 0 THEN '' ELSE availability_watch_target.last_error END,
				available_source_id = CASE WHEN availability_watch_target.active = 0 THEN NULL ELSE availability_watch_target.available_source_id END,
				available_code = CASE WHEN availability_watch_target.active = 0 THEN '' ELSE availability_watch_target.available_code END,
				track_run_id = CASE WHEN availability_watch_target.active = 0 THEN NULL ELSE availability_watch_target.track_run_id END,
				fetch_run_id = CASE WHEN availability_watch_target.active = 0 THEN NULL ELSE availability_watch_target.fetch_run_id END,
				revision = availability_watch_target.revision + CASE WHEN availability_watch_target.active = 0 THEN 1 ELSE 0 END,
				created_at = CASE WHEN availability_watch_target.active = 0 THEN CURRENT_TIMESTAMP ELSE availability_watch_target.created_at END,
				updated_at = CASE WHEN availability_watch_target.active = 0 THEN CURRENT_TIMESTAMP ELSE availability_watch_target.updated_at END
		`, availabilityWatchID, code); err != nil {
			return err
		}
	}
	if !replace {
		return tx.Commit()
	}
	if len(codes) == 0 {
		_, err = tx.ExecContext(ctx, `
			UPDATE availability_watch_target
			SET active = 0, state = 'disabled', next_check_at = NULL,
				revision = revision + 1, updated_at = CURRENT_TIMESTAMP
			WHERE watch_id = ? AND active = 1
		`, availabilityWatchID)
	} else {
		args := []any{availabilityWatchID}
		placeholders := make([]string, len(codes))
		for index, code := range codes {
			placeholders[index] = "?"
			args = append(args, code)
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE availability_watch_target
			SET active = 0, state = 'disabled', next_check_at = NULL,
				revision = revision + 1, updated_at = CURRENT_TIMESTAMP
			WHERE watch_id = ? AND active = 1 AND work_code NOT IN (`+strings.Join(placeholders, ",")+`)
		`, args...)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

// availabilityWatchInLibrarySQL is true for a target row named `target` whose
// watched code or found edition has a work with an available local, cached,
// or tracked remote file location.
const availabilityWatchInLibrarySQL = `EXISTS (
	SELECT 1 FROM work
	INNER JOIN media_item ON media_item.work_id = work.id
	INNER JOIN media_file_location AS location ON location.media_item_id = media_item.id
	WHERE work.primary_code IN (target.work_code, NULLIF(target.available_code, ''))
		AND location.availability = 'available'
		AND location.location_type IN ('local', 'cache', 'remote_stream', 'remote_download')
)`

func (s *Server) loadAvailabilityWatch(ctx context.Context) (availabilityWatchView, error) {
	view := availabilityWatchView{Targets: []availabilityWatchTarget{}}
	var sourceID sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT id, source_id, revision FROM availability_watch WHERE id = ?
	`, availabilityWatchID).Scan(&view.ID, &sourceID, &view.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return view, nil
	}
	if err != nil {
		return view, err
	}
	if sourceID.Valid {
		view.SourceID = &sourceID.Int64
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT target.id, target.work_code, target.state, COALESCE(target.next_check_at, ''),
			COALESCE(target.last_checked_at, ''), target.last_status, target.last_error,
			target.available_source_id, target.available_code, target.track_run_id, target.fetch_run_id,
			COALESCE(track_run.status, ''), COALESCE(fetch_run.status, ''),
			`+availabilityWatchInLibrarySQL+`, target.created_at,
			COALESCE((SELECT release_date FROM work WHERE work.primary_code = target.work_code), ''),
			COALESCE((SELECT title FROM work WHERE work.primary_code = target.work_code), '')
		FROM availability_watch_target AS target
		LEFT JOIN workflow_run AS track_run ON track_run.id = target.track_run_id
		LEFT JOIN workflow_run AS fetch_run ON fetch_run.id = target.fetch_run_id
		WHERE target.watch_id = ? AND target.active = 1
		ORDER BY target.created_at DESC, target.id DESC
	`, availabilityWatchID)
	if err != nil {
		return view, err
	}
	defer rows.Close()
	for rows.Next() {
		var target availabilityWatchTarget
		var availableSourceID, trackRunID, fetchRunID sql.NullInt64
		if err := rows.Scan(
			&target.ID, &target.WorkCode, &target.State, &target.NextCheckAt, &target.LastCheckedAt, &target.LastStatus,
			&target.LastError, &availableSourceID, &target.AvailableCode, &trackRunID, &fetchRunID,
			&target.TrackRunStatus, &target.FetchRunStatus, &target.InLibrary, &target.AddedAt, &target.ReleaseDate,
			&target.Title,
		); err != nil {
			return view, err
		}
		if availableSourceID.Valid {
			target.AvailableSourceID = &availableSourceID.Int64
		}
		if trackRunID.Valid {
			target.TrackRunID = &trackRunID.Int64
		}
		if fetchRunID.Valid {
			target.FetchRunID = &fetchRunID.Int64
		}
		target.Family = []availabilityWatchFamilyMember{}
		view.Targets = append(view.Targets, target)
	}
	if err := rows.Err(); err != nil {
		return view, err
	}
	_ = rows.Close()
	families, err := s.loadAvailabilityWatchFamilies(ctx, `
		SELECT work_code FROM availability_watch_target WHERE watch_id = ? AND active = 1
	`, availabilityWatchID)
	if err != nil {
		return view, err
	}
	for index := range view.Targets {
		target := &view.Targets[index]
		// The family names the work; a code without family metadata keeps its
		// own work's title when the library has one.
		if family := families[target.WorkCode]; family != nil {
			target.Family = family
			target.Title = firstNonEmpty(availabilityWatchFamilyTitle(target.WorkCode, family), target.Title)
			target.CoverURL = s.availabilityWatchFamilyCover(target.WorkCode, family)
		} else {
			target.CoverURL = s.coverURL(target.WorkCode)
		}
	}
	return view, nil
}

// activeAvailabilityWatchCodes returns which of the codes the shared pool
// watches: an active target names the code or another edition of its family,
// since a target is available when any edition of its family is.
func (s *Server) activeAvailabilityWatchCodes(ctx context.Context, codes []string) (map[string]bool, error) {
	watched := map[string]bool{}
	if len(codes) == 0 {
		return watched, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		WITH requested(code) AS (SELECT DISTINCT UPPER(value) FROM json_each(?)),
		target(code) AS (
			SELECT UPPER(work_code) FROM availability_watch_target WHERE watch_id = ? AND active = 1
		),
		member(logical_work_id, code) AS (
			SELECT logical_work_id, UPPER(primary_code) FROM work_edition
			UNION
			SELECT logical_work_id, UPPER(primary_code) FROM work_code_alias
		)
		SELECT requested.code FROM requested
		WHERE requested.code IN (SELECT code FROM target)
			OR EXISTS (
				SELECT 1 FROM member AS own
				INNER JOIN member AS other ON other.logical_work_id = own.logical_work_id
				WHERE own.code = requested.code AND other.code IN (SELECT code FROM target)
			)
	`, mustJSON(codes), availabilityWatchID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		watched[code] = true
	}
	return watched, rows.Err()
}

func userHasPermission(user currentUser, permission string) bool {
	for _, item := range user.Permissions {
		if item == permission || item == "system:admin" {
			return true
		}
	}
	return false
}

func normalizeExtensionList(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "."))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

// enqueueAvailabilityWatch queues a check of the pool, or of the listed
// active targets when targetIDs names some.
func (s *Server) enqueueAvailabilityWatch(ctx context.Context, userID int64, trigger workflowRunTrigger, targetIDs ...int64) (availabilityWatchRunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var sourceID sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT source_id FROM availability_watch WHERE id = ?
	`, availabilityWatchID).Scan(&sourceID); err != nil {
		return availabilityWatchRunResult{}, err
	}
	var activeRuns int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM workflow_run
		WHERE workflow_code = 'availability_watch' AND status IN ('queued', 'running')
	`).Scan(&activeRuns); err != nil {
		return availabilityWatchRunResult{}, err
	}
	if activeRuns > 0 {
		return availabilityWatchRunResult{}, errAvailabilityWatchRunActive
	}
	subset := len(targetIDs) > 0
	rows, err := tx.QueryContext(ctx, `
		SELECT id, work_code, state, revision
		FROM availability_watch_target
		WHERE watch_id = ? AND active = 1
			AND (? = 0 OR id IN (SELECT value FROM json_each(?)))
		ORDER BY id
		LIMIT 1000
	`, availabilityWatchID, subset, mustJSON(targetIDs))
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	targets := []availabilityWatchTargetSnapshot{}
	for rows.Next() {
		var target availabilityWatchTargetSnapshot
		if err := rows.Scan(&target.ID, &target.WorkCode, &target.State, &target.Revision); err != nil {
			_ = rows.Close()
			return availabilityWatchRunResult{}, err
		}
		targets = append(targets, target)
	}
	if err := rows.Close(); err != nil {
		return availabilityWatchRunResult{}, err
	}
	payload := availabilityWatchJobPayload{RequestedByUserID: userID, Targets: targets}
	if sourceID.Valid {
		payload.SourceID = sourceID.Int64
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "availability_watch", availabilityWatchDisplayName, availabilityWatchDescription, availabilityWatchDefinition())
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	result := availabilityWatchRunResult{Status: "queued", TargetCount: len(targets), NewlyAvailableCodes: []string{}, ReadyCodes: []string{}, Failures: []string{}}
	input := map[string]any{"source_id": payload.SourceID, "target_count": len(targets), workflowRunRequesterKey: userID}
	if subset {
		input["target_ids"] = targetIDs
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "availability_watch", availabilityWatchDisplayName, "queued", trigger.Type, trigger.Reason, input, result)
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return availabilityWatchRunResult{}, err
		}
	}
	selectName := "Snapshot monitoring pool"
	if subset {
		selectName = "Snapshot selected targets"
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "targets", NodeType: "select_works", DisplayName: selectName, Position: 1,
		Status: "succeeded", Output: map[string]any{"target_count": len(targets)},
	}); err != nil {
		return availabilityWatchRunResult{}, err
	}
	metadataNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Refresh family metadata", Position: 2,
		Status: "queued", Input: map[string]any{"target_count": len(targets)},
	})
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "check", NodeType: "check_source_availability", DisplayName: "Check family availability", Position: 3, Status: "queued", Input: map[string]any{"source_id": payload.SourceID, "target_count": len(targets)}},
		{NodeID: "ready", NodeType: "filter_candidates", DisplayName: "Filter available works", Position: 4, Status: "queued"},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return availabilityWatchRunResult{}, err
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: metadataNodeID, WorkerType: "availability_watch", Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "availability:watch", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: false, MaxRetries: 1, ProgressTotal: len(targets),
	})
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return availabilityWatchRunResult{}, err
	}
	result.RunID = runID
	result.JobID = jobID
	return result, nil
}

func availabilityWatchDefinition() map[string]any {
	return map[string]any{"nodes": availabilityWatchNodes()}
}

func availabilityWatchNodes() []map[string]string {
	return []map[string]string{
		{"id": "targets", "type": "select_works", "displayName": "Monitoring pool"},
		{"id": "metadata", "type": "sync_metadata", "displayName": "Refresh family metadata"},
		{"id": "check", "type": "check_source_availability", "displayName": "Check family availability"},
		{"id": "ready", "type": "filter_candidates", "displayName": "Available works"},
	}
}

func (s *Server) executeAvailabilityWatchJob(ctx context.Context, job workflowJobRecord) error {
	var payload availabilityWatchJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch snapshot is invalid")
		return err
	}
	if payload.RequestedByUserID <= 0 {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch requester is unavailable")
		return fmt.Errorf("availability watch requester is unavailable")
	}
	owner, err := s.accountStore.LoadByID(ctx, payload.RequestedByUserID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch requester is unavailable")
		return err
	}
	if missing := missingWorkflowGraphPermission(owner.Permissions, availabilityWatchPermissions); missing != "" {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch permission is no longer available")
		return fmt.Errorf("availability watch requires permission %s", missing)
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	healthy, healthErr := s.healthyRemoteSourceIDsForAvailability(ctx, payload.SourceID)
	if healthErr != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch source health check failed")
		return healthErr
	}
	execution := availabilityWatchExecution{
		result: availabilityWatchRunResult{
			RunID: job.RunID, JobID: job.ID, Status: "succeeded", TargetCount: len(payload.Targets),
			NewlyAvailableCodes: []string{}, ReadyCodes: []string{}, Failures: []string{},
		},
		readySeen: map[string]bool{},
		syncer:    s.newDLsiteMetadataSyncer(ctx),
	}
	for index, snapshot := range payload.Targets {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.executeAvailabilityWatchTarget(ctx, job, payload, snapshot, healthy, &execution); err != nil {
			return err
		}
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "checking", execution.result, index+1, len(payload.Targets))
	}
	execution.result.Ready = len(execution.result.ReadyCodes)
	if len(execution.result.Failures) > 0 {
		execution.result.Status = "partial"
	}
	if err := s.finishAvailabilityWatchJob(ctx, job, nodeIDs, execution); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch run could not be finalized")
		return err
	}
	return nil
}

// executeAvailabilityWatchTarget checks a waiting or failed target and
// records an available one; it never tracks or fetches.
func (s *Server) executeAvailabilityWatchTarget(
	ctx context.Context,
	job workflowJobRecord,
	payload availabilityWatchJobPayload,
	snapshot availabilityWatchTargetSnapshot,
	healthy map[int64]bool,
	execution *availabilityWatchExecution,
) error {
	target, err := s.loadAvailabilityWatchExecutionTarget(ctx, snapshot.ID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch target state could not be loaded")
		return err
	}
	if !target.Active || target.Revision != snapshot.Revision {
		return nil
	}
	code := strings.ToUpper(strings.TrimSpace(snapshot.WorkCode))
	if availabilityWatchTargetNeedsCheck(target.State) {
		ready, err := s.checkAvailabilityWatchExecutionTarget(ctx, job, payload, snapshot.ID, code, healthy, &target, execution)
		if err != nil || !ready {
			return err
		}
	}
	execution.recordReady(code, target.State)
	return nil
}

func availabilityWatchTargetNeedsCheck(state string) bool {
	return state == "monitoring" || state == "error"
}

func (s *Server) checkAvailabilityWatchExecutionTarget(
	ctx context.Context,
	job workflowJobRecord,
	payload availabilityWatchJobPayload,
	targetID int64,
	code string,
	healthy map[int64]bool,
	target *availabilityWatchExecutionTarget,
	execution *availabilityWatchExecution,
) (bool, error) {
	result := &execution.result
	result.Checked++
	if err := s.refreshAvailabilityWatchFamilyMetadata(ctx, execution.syncer, targetID, code, &execution.metadata); err != nil {
		if ctx.Err() == nil {
			_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch family metadata state could not be saved")
		}
		return false, err
	}
	if len(healthy) == 0 {
		result.Failures = append(result.Failures, code+": no healthy remote source")
		_ = s.updateAvailabilityWatchTargetError(ctx, targetID, target.Revision, "Remote source is unavailable")
		return false, nil
	}
	familyCodes, err := s.availabilityWatchFamilyCodes(ctx, code)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch family could not be loaded")
		return false, err
	}
	// Any edition of the family satisfies the watch; the watched code is
	// asked first.
	var available *sourceAvailabilitySummary
	availableCode := ""
	for _, familyCode := range familyCodes {
		response, err := s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, familyCode, payload.SourceID, healthy, "availability_watch", "workflow_run")
		if err != nil {
			if ctx.Err() != nil {
				return false, ctx.Err()
			}
			result.Failures = append(result.Failures, code+": availability check failed")
			_ = s.updateAvailabilityWatchTargetError(ctx, targetID, target.Revision, "Availability check failed")
			return false, nil
		}
		if hit := firstAvailableSource(response); hit != nil {
			available, availableCode = hit, familyCode
			break
		}
	}
	if available == nil {
		if err := s.updateAvailabilityWatchTargetNotFound(ctx, targetID, target.Revision); err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch result could not be saved")
			return false, err
		}
		return false, nil
	}
	if target.LastStatus != "available" {
		target.Epoch++
		result.NewlyAvailableCodes = append(result.NewlyAvailableCodes, code)
	}
	if err := s.updateAvailabilityWatchTargetReady(ctx, targetID, target.Revision, available.SourceID, availableCode, target.Epoch); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch result could not be saved")
		return false, err
	}
	target.State = "ready"
	target.AvailableSourceID = available.SourceID
	target.AvailableCode = availableCode
	return true, nil
}

func (execution *availabilityWatchExecution) recordReady(code string, state string) {
	if state != "ready" || execution.readySeen[code] {
		return
	}
	execution.readySeen[code] = true
	execution.result.ReadyCodes = append(execution.result.ReadyCodes, code)
}

func (s *Server) loadAvailabilityWatchExecutionTarget(ctx context.Context, targetID int64) (availabilityWatchExecutionTarget, error) {
	var target availabilityWatchExecutionTarget
	var nullableSourceID sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT state, revision, last_status, availability_epoch, available_source_id, available_code, active
		FROM availability_watch_target WHERE id = ? AND watch_id = ?
	`, targetID, availabilityWatchID).Scan(
		&target.State, &target.Revision, &target.LastStatus, &target.Epoch, &nullableSourceID, &target.AvailableCode, &target.Active,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return availabilityWatchExecutionTarget{}, nil
	}
	if err != nil {
		return availabilityWatchExecutionTarget{}, err
	}
	if nullableSourceID.Valid {
		target.AvailableSourceID = nullableSourceID.Int64
	}
	return target, nil
}

func (s *Server) updateAvailabilityWatchTargetError(ctx context.Context, targetID int64, revision int, message string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE availability_watch_target
		SET state = 'error', last_checked_at = CURRENT_TIMESTAMP, last_status = 'error',
			last_error = ?, next_check_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND revision = ?
	`, message, targetID, revision)
	return err
}

func (s *Server) updateAvailabilityWatchTargetNotFound(ctx context.Context, targetID int64, revision int) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE availability_watch_target
		SET state = 'monitoring', last_checked_at = CURRENT_TIMESTAMP, last_status = 'not_found',
			last_error = '', available_source_id = NULL, available_code = '', next_check_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND revision = ?
	`, targetID, revision)
	return err
}

func (s *Server) updateAvailabilityWatchTargetReady(ctx context.Context, targetID int64, revision int, sourceID int64, availableCode string, epoch int) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE availability_watch_target
		SET state = 'ready', last_checked_at = CURRENT_TIMESTAMP, last_status = 'available',
			last_error = '', available_source_id = ?, available_code = ?, availability_epoch = ?,
			next_check_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND revision = ?
	`, sourceID, availableCode, epoch, targetID, revision)
	return err
}

func firstAvailableSource(response sourceAvailabilityResponse) *sourceAvailabilitySummary {
	for index := range response.Sources {
		if response.Sources[index].Status == "available" {
			return &response.Sources[index]
		}
	}
	return nil
}

func (s *Server) finishAvailabilityWatchJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, execution availabilityWatchExecution) error {
	result, metadata := execution.result, execution.metadata
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Metadata failures fall back to the known family, so they mark only
	// their own node partial.
	metadataStatus := "succeeded"
	if len(metadata.Failed) > 0 {
		metadataStatus = "partial"
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, metadataStatus, mustJSON(map[string]any{"synced": len(metadata.Synced), "fresh": metadata.Skipped, "failures": metadata.Failed}), strings.Join(metadata.Failed, "\n"), nodeIDs["metadata"]); err != nil {
		return err
	}
	errorMessage := strings.Join(result.Failures, "\n")
	checkStatus := "succeeded"
	if len(result.Failures) > 0 {
		checkStatus = "partial"
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, checkStatus, mustJSON(map[string]any{"checked": result.Checked, "failures": result.Failures}), errorMessage, nodeIDs["check"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, mustJSON(map[string]any{"ready": result.Ready, "ready_codes": result.ReadyCodes, "newly_available_codes": result.NewlyAvailableCodes}), nodeIDs["ready"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.TargetCount, result.TargetCount, errorMessage, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, result.Status, mustJSON(result), job.RunID); err != nil {
		return err
	}
	if result.Status == "succeeded" {
		if err := updateWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
			return err
		}
	} else if err := updateWorkflowTriggerFailure(ctx, tx, job.RunID, "Availability Watch completed with some failures"); err != nil {
		return err
	}
	if len(result.NewlyAvailableCodes) > 0 {
		if err := createAvailabilityWatchNotifications(ctx, tx, job.RunID, result.NewlyAvailableCodes); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// availabilityWatchRecipients are the enabled accounts that can open the
// watch pool.
func availabilityWatchRecipients(ctx context.Context, tx *sql.Tx) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id, role FROM user_account WHERE enabled = 1 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	recipients := []int64{}
	for rows.Next() {
		var id int64
		var role string
		if err := rows.Scan(&id, &role); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if userHasPermission(currentUser{Permissions: account.PermissionsForRole(role)}, "workflows:run") {
			recipients = append(recipients, id)
		}
	}
	return recipients, rows.Close()
}

// createAvailabilityWatchNotifications notifies every account that can open
// the watch pool and adds each newly available work to its release feed.
func createAvailabilityWatchNotifications(ctx context.Context, tx *sql.Tx, runID int64, codes []string) error {
	message := fmt.Sprintf("%d watched works are now available.", len(codes))
	if len(codes) == 1 {
		message = codes[0] + " is now available."
	}
	recipients, err := availabilityWatchRecipients(ctx, tx)
	if err != nil {
		return err
	}
	for _, userID := range recipients {
		for _, code := range codes {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind, workflow_run_id)
				VALUES (?, ?, 'available', 'watch', ?)
				ON CONFLICT(user_id, primary_code, event_type) DO UPDATE SET
					created_at = CURRENT_TIMESTAMP,
					workflow_run_id = excluded.workflow_run_id
			`, userID, strings.ToUpper(code), runID); err != nil {
				return err
			}
		}
	}
	for _, userID := range recipients {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workflow_notification (
				user_id, workflow_run_id, notification_type, status, work_code, message
			)
			VALUES (?, ?, 'availability_watch_ready', 'succeeded', ?, ?)
			ON CONFLICT(user_id, workflow_run_id, notification_type) DO UPDATE SET
				status = excluded.status,
				work_code = excluded.work_code,
				message = excluded.message
		`, userID, runID, codes[0], message); err != nil {
			return err
		}
	}
	return nil
}
