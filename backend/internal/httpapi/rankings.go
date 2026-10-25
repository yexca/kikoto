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

// Rankings keep dated snapshots of the DLsite voice rankings and of remote
// sources' popular lists. Which rankings are tracked, how often each is
// pulled, and how long history is kept are shared configuration; what an
// account has seen is personal. Entries are catalog codes: a pull never
// creates a work, syncs metadata, tracks, fetches, or tags.

const (
	rankingProviderDLsite = "dlsite"
	rankingProviderRemote = "remote_source"

	rankingDefaultDepth = 100
	rankingMinDepth     = 10
	rankingMaxDepth     = 100

	rankingFirstYear = 2000

	// rankingReleaseWindow limits a 24-hour, 7-day, or 30-day ranking to works
	// released within 30 days; rankingSortSales orders a ranking by sales.
	rankingReleaseWindow = "30d"
	rankingSortSales     = "sale"
)

var (
	errRankingListNotFound = errors.New("ranking not found")
	errRankingListExists   = errors.New("this ranking is already tracked")
	errRankingOrderUnknown = errors.New("this ranking has no such order")
)

// rankingList is one tracked ranking with its schedule. A DLsite list is one
// period, and the annual ranking one year; a remote list is one source's
// popular list. Its variants are the orders it is pulled in.
type rankingList struct {
	ID         int64  `json:"id"`
	Provider   string `json:"provider"`
	SourceID   *int64 `json:"sourceId"`
	SourceName string `json:"sourceName"`
	// SourceAvailable is false for a remote list whose source is disabled or
	// no longer compatible; its lists are not pulled until it is enabled.
	SourceAvailable        bool             `json:"sourceAvailable"`
	Period                 string           `json:"period"`
	Year                   int              `json:"year"`
	Depth                  int              `json:"depth"`
	Enabled                bool             `json:"enabled"`
	AutoRefresh            bool             `json:"autoRefresh"`
	RefreshIntervalMinutes int              `json:"refreshIntervalMinutes"`
	NextPullAt             *string          `json:"nextPullAt"`
	PullRequested          bool             `json:"pullRequested"`
	FinalAt                *string          `json:"finalAt"`
	FollowCurrentYear      bool             `json:"followCurrentYear"`
	LastPulledAt           *string          `json:"lastPulledAt"`
	LastStatus             string           `json:"lastStatus"`
	Variants               []rankingVariant `json:"variants"`

	lastError    string
	failureCount int
}

// rankingVariant is one order of a list: all works or those released within
// 30 days, by popularity or by sales. Each variant keeps its own snapshots,
// statistics, and seen state.
type rankingVariant struct {
	ID            int64   `json:"id"`
	ReleaseWindow string  `json:"releaseWindow"`
	Sort          string  `json:"sort"`
	LastPulledAt  *string `json:"lastPulledAt"`
	LastChangedAt *string `json:"lastChangedAt"`
	LastStatus    string  `json:"lastStatus"`
	// Unseen is true when the variant's latest snapshot is newer than the one
	// the account last displayed.
	Unseen bool `json:"unseen"`

	listID           int64
	latestSnapshotID int64
	lastError        string
}

// rankingOrder is a release window and sort a list can be pulled in.
type rankingOrder struct {
	ReleaseWindow string
	Sort          string
}

// rankingOrdersFor lists the orders of a kind of list, the default first:
// DLsite offers the 30-day release window on its 24-hour, 7-day, and 30-day
// rankings and the sales order on every voice ranking.
func rankingOrdersFor(provider, period string) []rankingOrder {
	if provider == rankingProviderRemote {
		return []rankingOrder{{}}
	}
	orders := []rankingOrder{{}, {Sort: rankingSortSales}}
	if period == "day" || period == "week" || period == "month" {
		orders = []rankingOrder{{}, {ReleaseWindow: rankingReleaseWindow}, {Sort: rankingSortSales}, {ReleaseWindow: rankingReleaseWindow, Sort: rankingSortSales}}
	}
	return orders
}

// ensureRankingVariants adds the orders a list lacks.
func ensureRankingVariants(ctx context.Context, tx *sql.Tx, listID int64, provider, period string) error {
	for _, order := range rankingOrdersFor(provider, period) {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO ranking_variant (ranking_list_id, release_window, sort) VALUES (?, ?, ?) ON CONFLICT DO NOTHING
		`, listID, order.ReleaseWindow, order.Sort); err != nil {
			return err
		}
	}
	return nil
}

// variant returns the list's variant for an order.
func (list rankingList) variant(releaseWindow, sort string) (rankingVariant, bool) {
	for _, variant := range list.Variants {
		if variant.ReleaseWindow == releaseWindow && variant.Sort == sort {
			return variant, true
		}
	}
	return rankingVariant{}, false
}

// rankingWorkflowState is one pulling workflow's latest run and next
// automatic dispatch, for the settings' links.
type rankingWorkflowState struct {
	Code      string  `json:"code"`
	NextRunAt *string `json:"nextRunAt"`
	LatestRun *struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	} `json:"latestRun"`
}

type rankingOverview struct {
	Lists     []rankingList          `json:"lists"`
	Workflows []rankingWorkflowState `json:"workflows"`
	Retention rankingRetention       `json:"retention"`
	// CurrentYear is the DLsite annual ranking year in progress (JST).
	CurrentYear int `json:"currentYear"`
	// TimeZone is the zone the account reads times and days in, as for the
	// release feed; TimeZoneFollowsDevice when the account has none of its own.
	TimeZone              string `json:"timeZone"`
	TimeZoneFollowsDevice bool   `json:"timeZoneFollowsDevice"`
	Demo                  bool   `json:"demo"`
}

// rankingListSelectSQL reads lists with their source in the fixed order of the
// Rankings chips: DLsite 24 hours, 7 days, 30 days, the annual years newest
// first, and all time, then each remote source in its configured order.
const rankingListSelectSQL = `
	SELECT list.id, list.provider, list.file_source_id, COALESCE(source.display_name, ''),
		COALESCE(source.enabled = 1 AND source.source_type IN ('` + sourceTypeKikoeruCompatible + `', '` + sourceTypeKikoeruCompatible178 + `'), 0),
		list.period, list.year, list.depth, list.enabled,
		list.auto_refresh, list.refresh_interval_minutes, list.next_pull_at, list.pull_requested_at IS NOT NULL,
		list.final_at, list.follow_current_year, list.failure_count,
		list.last_pulled_at, list.last_status, list.last_error
	FROM ranking_list AS list
	LEFT JOIN file_source AS source ON source.id = list.file_source_id
`

const rankingListOrderSQL = `
	ORDER BY list.provider = 'remote_source',
		CASE list.period WHEN 'day' THEN 0 WHEN 'week' THEN 1 WHEN 'month' THEN 2 WHEN 'year' THEN 3 WHEN 'total' THEN 4 ELSE 5 END,
		list.year DESC, COALESCE(source.priority, 0), list.file_source_id, list.id
`

func (s *Server) loadRankingLists(ctx context.Context, userID int64, where string, args ...any) ([]rankingList, error) {
	return loadRankingListsFrom(ctx, s.db, userID, where, args...)
}

type rankingListReader interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func loadRankingListsFrom(ctx context.Context, reader rankingListReader, userID int64, where string, args ...any) ([]rankingList, error) {
	query := rankingListSelectSQL
	if where != "" {
		query += " WHERE " + where
	}
	rows, err := reader.QueryContext(ctx, query+rankingListOrderSQL, args...)
	if err != nil {
		return nil, err
	}
	lists := []rankingList{}
	index := map[int64]int{}
	for rows.Next() {
		var list rankingList
		var sourceID sql.NullInt64
		var nextPullAt, finalAt, lastPulledAt sql.NullString
		if err := rows.Scan(&list.ID, &list.Provider, &sourceID, &list.SourceName, &list.SourceAvailable,
			&list.Period, &list.Year, &list.Depth, &list.Enabled,
			&list.AutoRefresh, &list.RefreshIntervalMinutes, &nextPullAt, &list.PullRequested,
			&finalAt, &list.FollowCurrentYear, &list.failureCount,
			&lastPulledAt, &list.LastStatus, &list.lastError); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if sourceID.Valid {
			list.SourceID = &sourceID.Int64
		} else {
			list.SourceAvailable = true
		}
		if finalAt.Valid {
			list.FinalAt = &finalAt.String
		} else if nextPullAt.Valid {
			list.NextPullAt = &nextPullAt.String
		}
		if lastPulledAt.Valid {
			list.LastPulledAt = &lastPulledAt.String
		}
		list.Variants = []rankingVariant{}
		index[list.ID] = len(lists)
		lists = append(lists, list)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(lists) == 0 {
		return lists, nil
	}
	ids := make([]any, 0, len(lists)+1)
	ids = append(ids, userID)
	for _, list := range lists {
		ids = append(ids, list.ID)
	}
	variants, err := reader.QueryContext(ctx, `
		SELECT variant.id, variant.ranking_list_id, variant.release_window, variant.sort,
			variant.last_pulled_at, variant.last_status, variant.last_error,
			COALESCE(latest.id, 0), latest.pulled_at, COALESCE(state.seen_snapshot_id, 0)
		FROM ranking_variant AS variant
		LEFT JOIN ranking_snapshot AS latest ON latest.id = (
			SELECT snapshot.id FROM ranking_snapshot AS snapshot
			WHERE snapshot.ranking_variant_id = variant.id
			ORDER BY snapshot.pulled_at DESC, snapshot.id DESC
			LIMIT 1
		)
		LEFT JOIN user_ranking_state AS state ON state.ranking_variant_id = variant.id AND state.user_id = ?
		WHERE variant.ranking_list_id IN (`+sqlPlaceholders(len(lists))+`)
		ORDER BY variant.ranking_list_id, variant.sort, variant.release_window
	`, ids...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = variants.Close() }()
	for variants.Next() {
		var variant rankingVariant
		var lastPulledAt, latestAt sql.NullString
		var seenSnapshotID int64
		if err := variants.Scan(&variant.ID, &variant.listID, &variant.ReleaseWindow, &variant.Sort,
			&lastPulledAt, &variant.LastStatus, &variant.lastError,
			&variant.latestSnapshotID, &latestAt, &seenSnapshotID); err != nil {
			return nil, err
		}
		if lastPulledAt.Valid {
			variant.LastPulledAt = &lastPulledAt.String
		}
		if latestAt.Valid {
			variant.LastChangedAt = &latestAt.String
		}
		variant.Unseen = variant.latestSnapshotID > 0 && variant.latestSnapshotID > seenSnapshotID
		list := &lists[index[variant.listID]]
		list.Variants = append(list.Variants, variant)
	}
	return lists, variants.Err()
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
	zone, followsDevice := s.accountTimeZone(r, user.ID)
	if s.cfg.IsDemo() {
		overview := demoRankingOverview()
		overview.TimeZone, overview.TimeZoneFollowsDevice = zone, followsDevice
		writeJSON(w, http.StatusOK, overview)
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
	workflows, err := s.loadRankingWorkflowStates(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rankingOverview{
		Lists: lists, Workflows: workflows, Retention: s.rankingRetentionSettings(r.Context()),
		CurrentYear: currentRankingYear(time.Now()), TimeZone: zone, TimeZoneFollowsDevice: followsDevice,
	})
}

func (s *Server) loadRankingWorkflowStates(ctx context.Context) ([]rankingWorkflowState, error) {
	states := make([]rankingWorkflowState, 0, len(rankingWorkflowCodes))
	for _, code := range rankingWorkflowCodes {
		state := rankingWorkflowState{Code: code}
		var nextRunAt sql.NullString
		err := s.db.QueryRowContext(ctx, `
			SELECT trigger.next_run_at FROM workflow_trigger AS trigger
			INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
			WHERE definition.code = ? AND trigger.trigger_type = 'schedule' AND trigger.enabled = 1
			ORDER BY trigger.id LIMIT 1
		`, code).Scan(&nextRunAt)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if nextRunAt.Valid {
			state.NextRunAt = &nextRunAt.String
		}
		var latest struct {
			ID     int64  `json:"id"`
			Status string `json:"status"`
		}
		err = s.db.QueryRowContext(ctx, `SELECT id, status FROM workflow_run WHERE workflow_code = ? ORDER BY id DESC LIMIT 1`, code).Scan(&latest.ID, &latest.Status)
		if err == nil {
			state.LatestRun = &latest
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		states = append(states, state)
	}
	return states, nil
}

type rankingListRequest struct {
	Provider               string `json:"provider"`
	SourceID               int64  `json:"sourceId"`
	Period                 string `json:"period"`
	Year                   int    `json:"year"`
	Depth                  int    `json:"depth"`
	AutoRefresh            *bool  `json:"autoRefresh"`
	RefreshIntervalMinutes int    `json:"refreshIntervalMinutes"`
}

// normalizeRankingListRequest validates what a new list names. A DLsite list
// takes a period, or an annual year from 2000 to the year in progress in
// Japan; a remote list takes an enabled compatible source. A past year is
// pulled once and not scheduled.
func (s *Server) normalizeRankingListRequest(ctx context.Context, request rankingListRequest, now time.Time) (rankingListRequest, error) {
	request.Provider = strings.TrimSpace(request.Provider)
	request.Period = strings.ToLower(strings.TrimSpace(request.Period))
	if request.Depth == 0 {
		request.Depth = rankingDefaultDepth
	}
	if request.Depth < rankingMinDepth || request.Depth > rankingMaxDepth {
		return request, fmt.Errorf("depth must be between %d and %d", rankingMinDepth, rankingMaxDepth)
	}
	switch request.Provider {
	case rankingProviderDLsite:
		request.SourceID = 0
		switch request.Period {
		case "day", "week", "month", "total":
			request.Year = 0
		case "year":
			if current := currentRankingYear(now); request.Year < rankingFirstYear || request.Year > current {
				return request, fmt.Errorf("year must be between %d and %d", rankingFirstYear, current)
			}
		default:
			return request, fmt.Errorf("period must be day, week, month, year, or total")
		}
	case rankingProviderRemote:
		if request.Period != "" || request.Year != 0 {
			return request, fmt.Errorf("a remote source ranking takes no period or year")
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
	limits := rankingIntervalRangeFor(request.Provider, request.Period)
	if request.RefreshIntervalMinutes == 0 {
		request.RefreshIntervalMinutes = limits.Default
	}
	if request.RefreshIntervalMinutes < limits.Min || request.RefreshIntervalMinutes > limits.Max {
		return request, fmt.Errorf("refreshIntervalMinutes must be between %d and %d", limits.Min, limits.Max)
	}
	autoRefresh := request.Period != "year" || request.Year == currentRankingYear(now)
	if request.AutoRefresh != nil && autoRefresh {
		autoRefresh = *request.AutoRefresh
	}
	request.AutoRefresh = &autoRefresh
	return request, nil
}

// remoteCollectionSource loads a remote source named by a ranking or preset.
func (s *Server) remoteCollectionSource(ctx context.Context, sourceID int64) (remoteSourceForUse, error) {
	if sourceID <= 0 {
		return remoteSourceForUse{}, fmt.Errorf("sourceId is required")
	}
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteSourceForUse{}, fmt.Errorf("source not found")
	}
	return source, err
}

// createRanking starts tracking a ranking the settings offer: the list and its
// orders are created when it is first shown, and its first pull is queued at
// once.
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
	now := time.Now().UTC()
	request, err := s.normalizeRankingListRequest(r.Context(), request, now)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	id, err := s.insertRankingList(r.Context(), request, now)
	if errors.Is(err, errRankingListExists) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	runs, err := s.requestRankingPulls(r.Context(), []int64{id}, actor.ID, "ranking_added")
	if err != nil {
		writeError(w, err)
		return
	}
	list, err := s.loadRankingList(r.Context(), actor.ID, id)
	if err != nil {
		writeError(w, err)
		return
	}
	var runID int64
	if len(runs) > 0 {
		runID = runs[0].RunID
	}
	writeJSON(w, http.StatusCreated, map[string]any{"list": list, "runId": runID})
}

func (s *Server) insertRankingList(ctx context.Context, request rankingListRequest, now time.Time) (int64, error) {
	var sourceID any
	if request.Provider == rankingProviderRemote {
		sourceID = request.SourceID
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO ranking_list (provider, file_source_id, period, year, depth, auto_refresh, refresh_interval_minutes, pull_requested_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT DO NOTHING
	`, request.Provider, sourceID, request.Period, request.Year, request.Depth,
		*request.AutoRefresh, request.RefreshIntervalMinutes, formatWorkflowTimestamp(now))
	if err != nil {
		return 0, err
	}
	if inserted, _ := result.RowsAffected(); inserted == 0 {
		return 0, errRankingListExists
	}
	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if err := ensureRankingVariants(ctx, tx, id, request.Provider, request.Period); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

type rankingListUpdate struct {
	Enabled                *bool `json:"enabled"`
	AutoRefresh            *bool `json:"autoRefresh"`
	RefreshIntervalMinutes *int  `json:"refreshIntervalMinutes"`
	FollowCurrentYear      *bool `json:"followCurrentYear"`
	Depth                  *int  `json:"depth"`
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
	var payload rankingListUpdate
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
	next, err := applyRankingListUpdate(current, payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.saveRankingList(r.Context(), current, next, time.Now().UTC()); err != nil {
		writeError(w, err)
		return
	}
	if next.Enabled && !current.Enabled && next.LastPulledAt == nil {
		if _, err := s.requestRankingPulls(r.Context(), []int64{id}, actor.ID, "ranking_added"); err != nil {
			writeError(w, err)
			return
		}
	} else {
		s.refreshRankingDispatchersBestEffort(r.Context())
	}
	list, err := s.loadRankingList(r.Context(), actor.ID, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// applyRankingListUpdate validates a settings change. A finalized annual list
// keeps no schedule, so only whether it is shown and its depth change.
func applyRankingListUpdate(list rankingList, payload rankingListUpdate) (rankingList, error) {
	if payload.Enabled != nil {
		list.Enabled = *payload.Enabled
	}
	if payload.Depth != nil {
		list.Depth = *payload.Depth
	}
	if list.Depth < rankingMinDepth || list.Depth > rankingMaxDepth {
		return list, fmt.Errorf("depth must be between %d and %d", rankingMinDepth, rankingMaxDepth)
	}
	if list.FinalAt != nil && (payload.AutoRefresh != nil || payload.RefreshIntervalMinutes != nil || payload.FollowCurrentYear != nil) {
		return list, fmt.Errorf("a finished annual ranking has no schedule")
	}
	if payload.AutoRefresh != nil {
		list.AutoRefresh = *payload.AutoRefresh
	}
	if payload.RefreshIntervalMinutes != nil {
		limits := rankingIntervalRangeFor(list.Provider, list.Period)
		if *payload.RefreshIntervalMinutes < limits.Min || *payload.RefreshIntervalMinutes > limits.Max {
			return list, fmt.Errorf("refreshIntervalMinutes must be between %d and %d", limits.Min, limits.Max)
		}
		list.RefreshIntervalMinutes = *payload.RefreshIntervalMinutes
	}
	if payload.FollowCurrentYear != nil {
		if list.Period != "year" {
			return list, fmt.Errorf("only an annual ranking follows the current year")
		}
		list.FollowCurrentYear = *payload.FollowCurrentYear
	}
	return list, nil
}

// saveRankingList stores a list's settings and plans its next pull from its
// last one when its schedule changed.
func (s *Server) saveRankingList(ctx context.Context, current, next rankingList, now time.Time) error {
	nextPullAt := any(nil)
	if current.NextPullAt != nil {
		nextPullAt = *current.NextPullAt
	}
	if next.FinalAt == nil && (current.AutoRefresh != next.AutoRefresh || current.RefreshIntervalMinutes != next.RefreshIntervalMinutes || current.Enabled != next.Enabled) {
		from := now
		if last, ok := parseWorkflowTimestamp(stringValue(next.LastPulledAt)); ok {
			from = last
		}
		nextPullAt = formatOptionalWorkflowTimestamp(nextRankingPullAt(next, from))
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE ranking_list
		SET enabled = ?, depth = ?, auto_refresh = ?, refresh_interval_minutes = ?, follow_current_year = ?, next_pull_at = ?
		WHERE id = ?
	`, next.Enabled, next.Depth, next.AutoRefresh, next.RefreshIntervalMinutes, next.FollowCurrentYear, nextPullAt, next.ID)
	return err
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
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
	s.refreshRankingDispatchersBestEffort(r.Context())
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) rejectDemoRankingWrite(w http.ResponseWriter) bool {
	if !s.cfg.IsDemo() {
		return false
	}
	writeAPIError(w, http.StatusForbidden, "demo_read_only", "rankings are read-only in demo", false)
	return true
}

// runRankingRefresh pulls the named lists now, or every enabled list.
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
	runs, err := s.requestRankingPulls(r.Context(), payload.ListIDs, actor.ID, "manual_run")
	if errors.Is(err, errRankingNothingToPull) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	status := http.StatusOK
	for _, run := range runs {
		if run.JobID > 0 {
			status = http.StatusAccepted
		}
	}
	writeJSON(w, status, map[string]any{"runs": runs})
}
