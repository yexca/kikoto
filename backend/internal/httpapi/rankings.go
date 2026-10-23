package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Rankings keep dated snapshots of the DLsite voice ranking and of remote
// sources' popular lists. Which rankings are tracked is shared configuration;
// what an account has seen is personal. Entries are catalog codes: a pull
// never creates a work, syncs metadata, tracks, fetches, or tags.

const (
	rankingProviderDLsite = "dlsite"
	rankingProviderRemote = "remote_source"

	rankingDefaultDepth = 100
	rankingMinDepth     = 10
	rankingMaxDepth     = 100

	rankingMinIntervalHours     = 1
	rankingMaxIntervalHours     = 168
	rankingDefaultIntervalHours = 24

	// rankingRetention is how long snapshots and dropped entries are kept.
	rankingRetention = "-90 days"
	// rankingSnapshotChoices bounds the snapshots offered for comparison.
	rankingSnapshotChoices = 60
)

var (
	errRankingListNotFound = errors.New("ranking not found")
	errRankingListExists   = errors.New("this ranking is already tracked")
)

type rankingList struct {
	ID            int64   `json:"id"`
	Provider      string  `json:"provider"`
	SourceID      *int64  `json:"sourceId"`
	SourceName    string  `json:"sourceName"`
	Period        string  `json:"period"`
	ReleaseWindow string  `json:"releaseWindow"`
	Depth         int     `json:"depth"`
	Enabled       bool    `json:"enabled"`
	Position      int     `json:"position"`
	LastPulledAt  *string `json:"lastPulledAt"`
	LastChangedAt *string `json:"lastChangedAt"`
	LastStatus    string  `json:"lastStatus"`
	Unseen        bool    `json:"unseen"`

	latestSnapshotID int64
	lastError        string
}

type rankingSchedule struct {
	Enabled       bool    `json:"enabled"`
	IntervalHours int     `json:"intervalHours"`
	NextRunAt     *string `json:"nextRunAt"`
	LastRunAt     *string `json:"lastRunAt"`
	LastSuccessAt *string `json:"lastSuccessAt"`
	LastError     string  `json:"lastError"`
	LatestRun     *struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	} `json:"latestRun"`
	triggerID int64
}

type rankingOverview struct {
	Lists    []rankingList   `json:"lists"`
	Schedule rankingSchedule `json:"schedule"`
	Demo     bool            `json:"demo"`
}

// rankingListSelectSQL reads lists with their source name, latest snapshot,
// and the account's seen snapshot; the account id is its only argument.
const rankingListSelectSQL = `
	SELECT list.id, list.provider, list.file_source_id, COALESCE(source.display_name, ''),
		list.period, list.release_window, list.depth, list.enabled, list.position,
		list.last_pulled_at, list.last_status, list.last_error,
		COALESCE(latest.id, 0), latest.pulled_at, COALESCE(state.seen_snapshot_id, 0)
	FROM ranking_list AS list
	LEFT JOIN file_source AS source ON source.id = list.file_source_id
	LEFT JOIN ranking_snapshot AS latest ON latest.id = (
		SELECT snapshot.id FROM ranking_snapshot AS snapshot
		WHERE snapshot.ranking_list_id = list.id
		ORDER BY snapshot.pulled_at DESC, snapshot.id DESC
		LIMIT 1
	)
	LEFT JOIN user_ranking_state AS state ON state.ranking_list_id = list.id AND state.user_id = ?
`

func (s *Server) loadRankingLists(ctx context.Context, userID int64, where string, args ...any) ([]rankingList, error) {
	query := rankingListSelectSQL
	if where != "" {
		query += " WHERE " + where
	}
	query += " ORDER BY list.position, list.id"
	rows, err := s.db.QueryContext(ctx, query, append([]any{userID}, args...)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	lists := []rankingList{}
	for rows.Next() {
		var list rankingList
		var sourceID sql.NullInt64
		var lastPulledAt, latestAt sql.NullString
		var seenSnapshotID int64
		if err := rows.Scan(&list.ID, &list.Provider, &sourceID, &list.SourceName, &list.Period, &list.ReleaseWindow,
			&list.Depth, &list.Enabled, &list.Position, &lastPulledAt, &list.LastStatus, &list.lastError,
			&list.latestSnapshotID, &latestAt, &seenSnapshotID); err != nil {
			return nil, err
		}
		if sourceID.Valid {
			list.SourceID = &sourceID.Int64
		}
		if lastPulledAt.Valid {
			list.LastPulledAt = &lastPulledAt.String
		}
		if latestAt.Valid {
			list.LastChangedAt = &latestAt.String
		}
		list.Unseen = list.latestSnapshotID > 0 && list.latestSnapshotID > seenSnapshotID
		lists = append(lists, list)
	}
	return lists, rows.Err()
}

func (s *Server) loadRankingList(ctx context.Context, userID, id int64) (rankingList, error) {
	lists, err := s.loadRankingLists(ctx, userID, "list.id = ?", id)
	if err != nil {
		return rankingList{}, err
	}
	if len(lists) == 0 {
		return rankingList{}, errRankingListNotFound
	}
	return lists[0], nil
}

func (s *Server) listRankings(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeJSON(w, http.StatusOK, demoRankingOverview())
		return
	}
	where := "list.enabled = 1"
	if userHasPermission(user, "metadata:sync") {
		where = ""
	}
	lists, err := s.loadRankingLists(r.Context(), user.ID, where)
	if err != nil {
		writeError(w, err)
		return
	}
	schedule, err := s.loadRankingSchedule(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rankingOverview{Lists: lists, Schedule: schedule})
}

type rankingListRequest struct {
	Provider      string `json:"provider"`
	SourceID      int64  `json:"sourceId"`
	Period        string `json:"period"`
	ReleaseWindow string `json:"releaseWindow"`
	Depth         int    `json:"depth"`
}

// normalizeRankingListRequest validates what a new list names. A DLsite list
// takes a period and an optional 30-day release window; a remote list takes an
// enabled compatible source.
func (s *Server) normalizeRankingListRequest(ctx context.Context, request rankingListRequest) (rankingListRequest, error) {
	request.Provider = strings.TrimSpace(request.Provider)
	request.Period = strings.ToLower(strings.TrimSpace(request.Period))
	request.ReleaseWindow = strings.ToLower(strings.TrimSpace(request.ReleaseWindow))
	if request.Depth == 0 {
		request.Depth = rankingDefaultDepth
	}
	if request.Depth < rankingMinDepth || request.Depth > rankingMaxDepth {
		return request, fmt.Errorf("depth must be between %d and %d", rankingMinDepth, rankingMaxDepth)
	}
	switch request.Provider {
	case rankingProviderDLsite:
		switch request.Period {
		case "day", "week", "month":
		default:
			return request, fmt.Errorf("period must be day, week, or month")
		}
		if request.ReleaseWindow != "" && request.ReleaseWindow != "30d" {
			return request, fmt.Errorf("releaseWindow must be empty or 30d")
		}
		request.SourceID = 0
	case rankingProviderRemote:
		if request.Period != "" || request.ReleaseWindow != "" {
			return request, fmt.Errorf("a remote source ranking takes no period or release window")
		}
		source, err := s.remoteCollectionSource(ctx, request.SourceID)
		if err != nil {
			return request, err
		}
		if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
			return request, fmt.Errorf("source is not an enabled compatible remote source")
		}
	default:
		return request, fmt.Errorf("provider must be dlsite or remote_source")
	}
	return request, nil
}

func (s *Server) createRanking(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	if s.rejectDemoRankingWrite(w) {
		return
	}
	var request rankingListRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	request, err := s.normalizeRankingListRequest(r.Context(), request)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	var sourceID any
	if request.Provider == rankingProviderRemote {
		sourceID = request.SourceID
	}
	result, err := s.db.ExecContext(r.Context(), `
		INSERT INTO ranking_list (provider, file_source_id, period, release_window, depth, position)
		SELECT ?, ?, ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM ranking_list WHERE true
		ON CONFLICT DO NOTHING
	`, request.Provider, sourceID, request.Period, request.ReleaseWindow, request.Depth)
	if err != nil {
		writeError(w, err)
		return
	}
	if inserted, _ := result.RowsAffected(); inserted == 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": errRankingListExists.Error()})
		return
	}
	id, err := result.LastInsertId()
	if err != nil {
		writeError(w, err)
		return
	}
	run, err := s.enqueueRankingRefresh(r.Context(), workflowRunTrigger{Type: "manual", Reason: "ranking_added"}, actor.ID, []int64{id})
	if err != nil && !errors.Is(err, errRankingRunActive) {
		writeError(w, err)
		return
	}
	list, err := s.loadRankingList(r.Context(), actor.ID, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"list": list, "runId": run.RunID})
}

func (s *Server) updateRanking(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	if s.rejectDemoRankingWrite(w) {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ranking id"})
		return
	}
	var payload struct {
		Enabled  *bool `json:"enabled"`
		Depth    *int  `json:"depth"`
		Position *int  `json:"position"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	current, err := s.loadRankingList(r.Context(), actor.ID, id)
	if errors.Is(err, errRankingListNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	enabled, depth, position := current.Enabled, current.Depth, current.Position
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	if payload.Depth != nil {
		depth = *payload.Depth
	}
	if payload.Position != nil {
		position = max(0, *payload.Position)
	}
	if depth < rankingMinDepth || depth > rankingMaxDepth {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("depth must be between %d and %d", rankingMinDepth, rankingMaxDepth)})
		return
	}
	if err := s.moveRankingList(r.Context(), id, enabled, depth, position); err != nil {
		writeError(w, err)
		return
	}
	list, err := s.loadRankingList(r.Context(), actor.ID, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// moveRankingList saves a list's options and renumbers every list so its
// position is the requested one.
func (s *Server) moveRankingList(ctx context.Context, id int64, enabled bool, depth, position int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE ranking_list SET enabled = ?, depth = ? WHERE id = ?", enabled, depth, id); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id FROM ranking_list WHERE id <> ? ORDER BY position, id", id)
	if err != nil {
		return err
	}
	order := []int64{}
	for rows.Next() {
		var other int64
		if err := rows.Scan(&other); err != nil {
			_ = rows.Close()
			return err
		}
		order = append(order, other)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	position = min(position, len(order))
	order = append(order[:position], append([]int64{id}, order[position:]...)...)
	for index, listID := range order {
		if _, err := tx.ExecContext(ctx, "UPDATE ranking_list SET position = ? WHERE id = ?", index, listID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) deleteRanking(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	if s.rejectDemoRankingWrite(w) {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ranking id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM ranking_list WHERE id = ?", id)
	if err != nil {
		writeError(w, err)
		return
	}
	if removed, _ := result.RowsAffected(); removed == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": errRankingListNotFound.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) rejectDemoRankingWrite(w http.ResponseWriter) bool {
	if !s.cfg.IsDemo() {
		return false
	}
	writeAPIError(w, http.StatusForbidden, "demo_read_only", "rankings are read-only in demo", false)
	return true
}

// The schedule is the fixed interval trigger of the ranking refresh workflow.

func (s *Server) loadRankingSchedule(ctx context.Context) (rankingSchedule, error) {
	schedule := rankingSchedule{IntervalHours: rankingDefaultIntervalHours}
	var scheduleJSON string
	var nextRunAt, lastRunAt, lastSuccessAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT trigger.id, trigger.enabled, trigger.schedule_json,
			trigger.next_run_at, trigger.last_run_at, trigger.last_success_at, trigger.last_error_message
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = ? AND trigger.trigger_type = 'schedule'
		ORDER BY trigger.id
		LIMIT 1
	`, rankingWorkflowCode).Scan(&schedule.triggerID, &schedule.Enabled, &scheduleJSON,
		&nextRunAt, &lastRunAt, &lastSuccessAt, &schedule.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return schedule, nil
	}
	if err != nil {
		return schedule, err
	}
	var interval workflowIntervalSchedule
	if json.Unmarshal([]byte(scheduleJSON), &interval) == nil && interval.IntervalMinutes > 0 {
		schedule.IntervalHours = max(rankingMinIntervalHours, (interval.IntervalMinutes+59)/60)
	}
	if nextRunAt.Valid && schedule.Enabled {
		schedule.NextRunAt = &nextRunAt.String
	}
	if lastRunAt.Valid {
		schedule.LastRunAt = &lastRunAt.String
	}
	if lastSuccessAt.Valid {
		schedule.LastSuccessAt = &lastSuccessAt.String
	}
	var latest struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	err = s.db.QueryRowContext(ctx, `
		SELECT id, status FROM workflow_run WHERE workflow_code = ? ORDER BY id DESC LIMIT 1
	`, rankingWorkflowCode).Scan(&latest.ID, &latest.Status)
	if err == nil {
		schedule.LatestRun = &latest
	} else if !errors.Is(err, sql.ErrNoRows) {
		return schedule, err
	}
	return schedule, nil
}

// ensureRankingSchedule keeps the fixed schedule present and plans its first
// run after startup.
func (s *Server) ensureRankingSchedule(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
		SELECT definition.id, 'schedule', 'Ranking refresh', 1, ?, '{}'
		FROM workflow_definition AS definition
		WHERE definition.code = ? AND NOT EXISTS (
			SELECT 1 FROM workflow_trigger AS trigger WHERE trigger.workflow_definition_id = definition.id
		)
	`, mustJSON(workflowIntervalSchedule{IntervalMinutes: rankingDefaultIntervalHours * 60}), rankingWorkflowCode); err != nil {
		return err
	}
	schedule, err := s.loadRankingSchedule(ctx)
	if err != nil || schedule.triggerID == 0 || !schedule.Enabled {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE workflow_trigger SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at IS NULL
	`, formatWorkflowTimestamp(time.Now().UTC().Add(time.Duration(schedule.IntervalHours)*time.Hour)), schedule.triggerID)
	return err
}

func (s *Server) updateRankingSchedule(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	if s.rejectDemoRankingWrite(w) {
		return
	}
	var payload struct {
		Enabled       *bool `json:"enabled"`
		IntervalHours *int  `json:"intervalHours"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	current, err := s.loadRankingSchedule(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if current.triggerID == 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "the ranking schedule is unavailable"})
		return
	}
	enabled, interval := current.Enabled, current.IntervalHours
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	if payload.IntervalHours != nil {
		interval = *payload.IntervalHours
	}
	if interval < rankingMinIntervalHours || interval > rankingMaxIntervalHours {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("intervalHours must be between %d and %d", rankingMinIntervalHours, rankingMaxIntervalHours)})
		return
	}
	var nextRunAt any
	if enabled {
		nextRunAt = formatWorkflowTimestamp(time.Now().UTC().Add(time.Duration(interval) * time.Hour))
	}
	if _, err := s.db.ExecContext(r.Context(), `
		UPDATE workflow_trigger
		SET enabled = ?, schedule_json = ?, next_run_at = ?, last_error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, enabled, mustJSON(workflowIntervalSchedule{IntervalMinutes: interval * 60}), nextRunAt, current.triggerID); err != nil {
		writeError(w, err)
		return
	}
	schedule, err := s.loadRankingSchedule(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, schedule)
}

func (s *Server) runRankingRefresh(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	if s.rejectDemoRankingWrite(w) {
		return
	}
	var payload struct {
		ListIDs []int64 `json:"listIds"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&payload); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
	}
	result, err := s.enqueueRankingRefresh(r.Context(), workflowRunTrigger{Type: "manual", Reason: "manual_run"}, actor.ID, payload.ListIDs)
	if errors.Is(err, errRankingRunActive) {
		writeJSON(w, http.StatusOK, result)
		return
	}
	if errors.Is(err, errRankingNothingToPull) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}
