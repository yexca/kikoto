package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	voiceCatalogRefreshWorker   = "voice_catalog_refresh"
	voiceCatalogRefreshWorkflow = "voice_catalog_refresh"
	voiceCatalogSourceTimeout   = 15 * time.Minute
	voiceCatalogRefreshAge      = 30 * 24 * time.Hour
	voiceCatalogRetryDelay      = 10 * time.Minute
)

var (
	errVoiceCatalogRefreshInProgress = errors.New("a voice catalog workflow is already running")
	errVoiceCatalogNoSourcesSelected = errors.New("select at least one remote source")
)

type voiceCatalogRefreshPayload struct {
	PersonID   int64    `json:"person_id"`
	Queries    []string `json:"queries"`
	Generation int64    `json:"generation"`
	Scope      string   `json:"scope"`
	Mode       string   `json:"mode"`
	SourceIDs  []int64  `json:"source_ids"`
}

type voiceCatalogRefreshRequest struct {
	Scope     string  `json:"scope"`
	Mode      string  `json:"mode"`
	SourceIDs []int64 `json:"sourceIds"`
}

type voiceCatalogQueryCursor struct {
	Query    string   `json:"query"`
	Frontier []string `json:"frontier"`
}

type voiceCatalogSourceStatus struct {
	SourceID    int64                     `json:"sourceId"`
	SourceCode  string                    `json:"sourceCode"`
	DisplayName string                    `json:"displayName"`
	Status      string                    `json:"status"`
	Error       string                    `json:"error"`
	Pages       int                       `json:"pages"`
	Total       int                       `json:"total"`
	Matches     int                       `json:"matches"`
	ElapsedMS   int64                     `json:"elapsedMs"`
	Cursors     []voiceCatalogQueryCursor `json:"cursors,omitempty"`
}

type voiceCatalogRefreshState struct {
	Status         string                     `json:"status"`
	Reason         string                     `json:"reason"`
	LastStatus     string                     `json:"lastStatus"`
	Generation     int64                      `json:"generation"`
	RunID          int64                      `json:"runId,omitempty"`
	LastAttemptAt  string                     `json:"lastAttemptAt"`
	LastSuccessAt  string                     `json:"lastSuccessAt"`
	Complete       bool                       `json:"complete"`
	PagesFetched   int                        `json:"pagesFetched"`
	CatalogWorks   int                        `json:"catalogWorks"`
	MetadataQueued int                        `json:"metadataQueued"`
	Queries        []string                   `json:"queries"`
	Sources        []voiceCatalogSourceStatus `json:"sources"`
	LastError      string                     `json:"error"`
	Scope          string                     `json:"scope,omitempty"`
	Mode           string                     `json:"mode,omitempty"`
	SourceIDs      []int64                    `json:"sourceIds,omitempty"`
	exists         bool
}

type voiceCatalogCandidate struct {
	CanonicalCode string
	WorkID        int64
	RemoteCode    string
	Projection    remoteCatalogWorkProjection
	RawJSON       string
}

type voiceCatalogSourceResult struct {
	Source     remoteSourceForUse
	Status     voiceCatalogSourceStatus
	Candidates []voiceCatalogCandidate
	Complete   bool
	Full       bool
	Err        error
}

type voiceCatalogMetadataResult struct {
	Targeted int
	Synced   int
	Skipped  int
	Failed   int
}

type voiceCatalogMetadataTarget struct {
	FamilyCode string
}

type voiceCatalogPersonSnapshot struct {
	Items   []voiceCatalogItemSnapshot        `json:"items"`
	Refresh *voiceCatalogRefreshStateSnapshot `json:"refresh,omitempty"`
}

type voiceCatalogItemSnapshot struct {
	PrimaryCode        string                       `json:"primaryCode"`
	WorkID             *int64                       `json:"workId,omitempty"`
	Title              string                       `json:"title"`
	ReleaseDate        *string                      `json:"releaseDate,omitempty"`
	CoverURL           string                       `json:"coverUrl"`
	SourceURL          string                       `json:"sourceUrl"`
	Circle             string                       `json:"circle"`
	AgeRating          string                       `json:"ageRating"`
	RatingAverage      *float64                     `json:"ratingAverage,omitempty"`
	RatingCount        *int64                       `json:"ratingCount,omitempty"`
	SalesCount         *int64                       `json:"salesCount,omitempty"`
	CurrentPrice       *int64                       `json:"currentPrice,omitempty"`
	TagsJSON           string                       `json:"tagsJson"`
	VoiceActorsJSON    string                       `json:"voiceActorsJson"`
	RawJSON            string                       `json:"rawJson"`
	CatalogStatus      string                       `json:"catalogStatus"`
	SnapshotGeneration int64                        `json:"snapshotGeneration"`
	LastSeenAt         string                       `json:"lastSeenAt"`
	CreatedAt          string                       `json:"createdAt"`
	UpdatedAt          string                       `json:"updatedAt"`
	Sources            []voiceCatalogSourceSnapshot `json:"sources"`
}

type voiceCatalogSourceSnapshot struct {
	ProviderID         int64  `json:"providerId"`
	RemoteID           string `json:"remoteId"`
	RemoteCode         string `json:"remoteCode"`
	SourceURL          string `json:"sourceUrl"`
	Availability       string `json:"availability"`
	RawJSON            string `json:"rawJson"`
	SnapshotGeneration int64  `json:"snapshotGeneration"`
	LastSeenAt         string `json:"lastSeenAt"`
	LastCheckedAt      string `json:"lastCheckedAt"`
	CreatedAt          string `json:"createdAt"`
	UpdatedAt          string `json:"updatedAt"`
}

type voiceCatalogRefreshStateSnapshot struct {
	Generation       int64   `json:"generation"`
	QueryJSON        string  `json:"queryJson"`
	SourceStatusJSON string  `json:"sourceStatusJson"`
	LastSuccessAt    *string `json:"lastSuccessAt,omitempty"`
	LastAttemptAt    *string `json:"lastAttemptAt,omitempty"`
	LastStatus       string  `json:"lastStatus"`
	LastRunID        *int64  `json:"lastRunId,omitempty"`
	LastError        string  `json:"lastError"`
	Complete         bool    `json:"complete"`
	PagesFetched     int     `json:"pagesFetched"`
	CatalogWorks     int     `json:"catalogWorks"`
	MetadataQueued   int     `json:"metadataQueued"`
	UpdatedAt        string  `json:"updatedAt"`
}

func (s *Server) autoRefreshVoiceCatalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	s.refreshVoiceCatalogResponse(w, r, false, voiceCatalogRefreshRequest{Scope: "all", Mode: "incremental"})
}

func (s *Server) refreshVoiceCatalog(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	var request voiceCatalogRefreshRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice catalog refresh request"})
			return
		}
	}
	s.refreshVoiceCatalogResponse(w, r, true, request)
}

func (s *Server) refreshVoiceCatalogResponse(w http.ResponseWriter, r *http.Request, force bool, request voiceCatalogRefreshRequest) {
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	state, err := s.ensureVoiceCatalogRefresh(r.Context(), personID, request, force)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		if errors.Is(err, errVoiceCatalogRefreshInProgress) {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "a voice catalog workflow is already running"})
			return
		}
		if errors.Is(err, errVoiceCatalogNoSourcesSelected) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "select at least one remote source"})
			return
		}
		writeError(w, err)
		return
	}
	status := http.StatusOK
	if state.Status == "queued" || state.Status == "running" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, state)
}

func (s *Server) ensureVoiceCatalogRefresh(ctx context.Context, personID int64, request voiceCatalogRefreshRequest, force bool) (voiceCatalogRefreshState, error) {
	request = normalizeVoiceCatalogRefreshRequest(request)
	queries := []string{}
	var err error
	if voiceCatalogRefreshIncludesRemote(request.Scope) {
		queries, err = s.voiceCatalogQueries(ctx, personID)
		if err != nil {
			return voiceCatalogRefreshState{}, err
		}
	} else if _, err := s.loadPersonName(ctx, personID); err != nil {
		return voiceCatalogRefreshState{}, err
	}
	state, err := s.loadVoiceCatalogRefreshState(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	if s.cfg.IsDemo() {
		state.Status = "skipped"
		state.Reason = "demo mode"
		return state, nil
	}
	if voiceCatalogRefreshIncludesRemote(request.Scope) && len(queries) == 0 {
		state.Status = "skipped"
		state.Reason = "voice actor has no searchable name"
		return state, nil
	}
	sources := []remoteSourceForUse{}
	if voiceCatalogRefreshIncludesRemote(request.Scope) {
		sources, err = s.resolveVoiceCatalogSources(ctx, request.SourceIDs)
		if err != nil {
			return voiceCatalogRefreshState{}, err
		}
		request.SourceIDs = voiceCatalogSourceIDs(sources)
	}

	s.voiceCatalogRefreshMu.Lock()
	defer s.voiceCatalogRefreshMu.Unlock()

	if active, ok, activeErr := s.activeVoiceCatalogRefresh(ctx, personID); activeErr != nil {
		return voiceCatalogRefreshState{}, activeErr
	} else if ok {
		if voiceCatalogRefreshRequestsEqual(active, request) {
			active.Queries = queries
			active.Reason = "refresh already running"
			return active, nil
		}
		return voiceCatalogRefreshState{}, errVoiceCatalogRefreshInProgress
	}

	state, err = s.loadVoiceCatalogRefreshState(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	reason, due := "manual refresh", true
	if voiceCatalogRefreshIncludesRemote(request.Scope) {
		reason, due = voiceCatalogRefreshReason(state, queries, force, time.Now().UTC())
	}
	if !due {
		state.Status = voiceCatalogIdleStatus(state)
		state.Reason = reason
		state.Queries = queries
		return state, nil
	}

	payload := voiceCatalogRefreshPayload{
		PersonID: personID, Queries: queries, Generation: state.Generation + 1,
		Scope: request.Scope, Mode: request.Mode, SourceIDs: voiceCatalogSourceIDs(sources),
	}
	return s.enqueueVoiceCatalogRefresh(ctx, payload, state, reason)
}

func normalizeVoiceCatalogRefreshRequest(request voiceCatalogRefreshRequest) voiceCatalogRefreshRequest {
	request.Scope = strings.ToLower(strings.TrimSpace(request.Scope))
	switch request.Scope {
	case "remote", "metadata":
	default:
		request.Scope = "all"
	}
	request.Mode = strings.ToLower(strings.TrimSpace(request.Mode))
	if request.Mode != "full" {
		request.Mode = "incremental"
	}
	if request.SourceIDs != nil {
		seen := map[int64]bool{}
		normalized := make([]int64, 0, len(request.SourceIDs))
		for _, sourceID := range request.SourceIDs {
			if sourceID <= 0 || seen[sourceID] {
				continue
			}
			seen[sourceID] = true
			normalized = append(normalized, sourceID)
		}
		sort.Slice(normalized, func(left int, right int) bool { return normalized[left] < normalized[right] })
		request.SourceIDs = normalized
	}
	return request
}

func voiceCatalogRefreshIncludesRemote(scope string) bool {
	return scope == "all" || scope == "remote"
}

func voiceCatalogRefreshIncludesMetadata(scope string) bool {
	return scope == "all" || scope == "metadata"
}

func voiceCatalogRefreshRequestsEqual(state voiceCatalogRefreshState, request voiceCatalogRefreshRequest) bool {
	request = normalizeVoiceCatalogRefreshRequest(request)
	if state.Scope != request.Scope || state.Mode != request.Mode || len(state.SourceIDs) != len(request.SourceIDs) {
		return false
	}
	for index := range state.SourceIDs {
		if state.SourceIDs[index] != request.SourceIDs[index] {
			return false
		}
	}
	return true
}

func (s *Server) resolveVoiceCatalogSources(ctx context.Context, requestedIDs []int64) ([]remoteSourceForUse, error) {
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	if requestedIDs == nil {
		return sources, nil
	}
	if len(requestedIDs) == 0 {
		return nil, errVoiceCatalogNoSourcesSelected
	}
	byID := make(map[int64]remoteSourceForUse, len(sources))
	for _, source := range sources {
		byID[source.ID] = source
	}
	selected := make([]remoteSourceForUse, 0, len(requestedIDs))
	for _, sourceID := range requestedIDs {
		source, ok := byID[sourceID]
		if !ok {
			return nil, fmt.Errorf("remote source is not configured")
		}
		selected = append(selected, source)
	}
	return selected, nil
}

func voiceCatalogSourceIDs(sources []remoteSourceForUse) []int64 {
	if len(sources) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(sources))
	for _, source := range sources {
		ids = append(ids, source.ID)
	}
	return ids
}

func voiceCatalogRefreshReason(state voiceCatalogRefreshState, queries []string, force bool, now time.Time) (string, bool) {
	if force {
		return "manual refresh", true
	}
	if !state.exists {
		return "first pull", true
	}
	if !state.Complete && (state.LastStatus == "failed" || state.LastStatus == "partial") {
		if state.LastAttemptAt != "" {
			if attemptedAt, err := parseSQLiteTime(state.LastAttemptAt); err == nil && now.Sub(attemptedAt) < voiceCatalogRetryDelay {
				return "recent refresh did not complete", false
			}
		}
		return "previous refresh did not complete", true
	}
	if state.LastSuccessAt == "" {
		return "first pull", true
	}
	if !equalFoldedStrings(state.Queries, queries) {
		return "voice aliases changed", true
	}
	lastSuccess, err := parseSQLiteTime(state.LastSuccessAt)
	if err != nil || now.Sub(lastSuccess) >= voiceCatalogRefreshAge {
		return "catalog is stale", true
	}
	return "catalog is fresh", false
}

func voiceCatalogIdleStatus(state voiceCatalogRefreshState) string {
	if state.LastStatus == "" {
		return "skipped"
	}
	if state.LastStatus == "succeeded" {
		return "skipped"
	}
	return state.LastStatus
}

func equalFoldedStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if !strings.EqualFold(strings.TrimSpace(left[index]), strings.TrimSpace(right[index])) {
			return false
		}
	}
	return true
}

func (s *Server) voiceCatalogQueries(ctx context.Context, personID int64) ([]string, error) {
	name, err := s.loadPersonName(ctx, personID)
	if err != nil {
		return nil, err
	}
	aliases, err := s.loadVoiceAliases(ctx, personID)
	if err != nil {
		return nil, err
	}
	values := make([]string, 0, len(aliases)+1)
	seen := map[string]bool{}
	appendValue := func(value string) {
		value = strings.TrimSpace(value)
		key := voiceNameKey(value)
		if value == "" || isUnknownVoiceActorName(value) || seen[key] {
			return
		}
		seen[key] = true
		values = append(values, value)
	}
	appendValue(name)
	for _, alias := range aliases {
		appendValue(alias.Alias)
	}
	return values, nil
}

func (s *Server) loadVoiceCatalogRefreshState(ctx context.Context, personID int64) (voiceCatalogRefreshState, error) {
	state := voiceCatalogRefreshState{Queries: []string{}, Sources: []voiceCatalogSourceStatus{}}
	var queryJSON, sourceJSON string
	var lastSuccess, lastAttempt sql.NullString
	var lastRunID sql.NullInt64
	var complete int
	err := s.db.QueryRowContext(ctx, `
		SELECT generation, query_json, source_status_json, last_success_at, last_attempt_at,
			last_status, last_run_id, last_error, complete, pages_fetched, catalog_works, metadata_queued
		FROM voice_catalog_refresh_state
		WHERE person_id = ?
	`, personID).Scan(
		&state.Generation, &queryJSON, &sourceJSON, &lastSuccess, &lastAttempt,
		&state.LastStatus, &lastRunID, &state.LastError, &complete, &state.PagesFetched,
		&state.CatalogWorks, &state.MetadataQueued,
	)
	if errors.Is(err, sql.ErrNoRows) {
		state.Status = "never"
		return state, nil
	}
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	state.exists = true
	state.Status = state.LastStatus
	state.Complete = complete != 0
	state.LastSuccessAt = voiceCatalogStringValue(lastSuccess)
	state.LastAttemptAt = voiceCatalogStringValue(lastAttempt)
	if lastRunID.Valid {
		state.RunID = lastRunID.Int64
	}
	_ = json.Unmarshal([]byte(queryJSON), &state.Queries)
	_ = json.Unmarshal([]byte(sourceJSON), &state.Sources)
	if state.Queries == nil {
		state.Queries = []string{}
	}
	if state.Sources == nil {
		state.Sources = []voiceCatalogSourceStatus{}
	}
	return state, nil
}

func (s *Server) currentVoiceCatalogRefreshState(ctx context.Context, personID int64) (voiceCatalogRefreshState, error) {
	state, err := s.loadVoiceCatalogRefreshState(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	active, ok, err := s.activeVoiceCatalogRefresh(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	if ok {
		return active, nil
	}
	return state, nil
}

func voiceCatalogStringValue(value sql.NullString) string {
	if value.Valid {
		return value.String
	}
	return ""
}

func (s *Server) activeVoiceCatalogRefresh(ctx context.Context, personID int64) (voiceCatalogRefreshState, bool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT run.id, run.status, run.input_json
		FROM workflow_run AS run
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id AND job.worker_type = ?
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
		ORDER BY run.id DESC
	`, voiceCatalogRefreshWorker, voiceCatalogRefreshWorkflow)
	if err != nil {
		return voiceCatalogRefreshState{}, false, err
	}
	defer rows.Close()
	var matchedRunID int64
	var matchedStatus string
	for rows.Next() {
		var runID int64
		var status, inputJSON string
		if err := rows.Scan(&runID, &status, &inputJSON); err != nil {
			return voiceCatalogRefreshState{}, false, err
		}
		var payload voiceCatalogRefreshPayload
		if json.Unmarshal([]byte(inputJSON), &payload) != nil || payload.PersonID != personID {
			continue
		}
		payload = normalizeVoiceCatalogRefreshPayload(payload)
		matchedRunID = runID
		matchedStatus = status
		state, stateErr := s.loadVoiceCatalogRefreshState(ctx, personID)
		if stateErr != nil {
			return voiceCatalogRefreshState{}, false, stateErr
		}
		state.Status = matchedStatus
		state.RunID = matchedRunID
		state.Scope = payload.Scope
		state.Mode = payload.Mode
		state.SourceIDs = append([]int64{}, payload.SourceIDs...)
		if voiceCatalogRefreshIncludesRemote(payload.Scope) {
			state.Queries = append([]string{}, payload.Queries...)
		}
		return state, true, nil
	}
	if err := rows.Err(); err != nil {
		return voiceCatalogRefreshState{}, false, err
	}
	return voiceCatalogRefreshState{}, false, nil
}

func normalizeVoiceCatalogRefreshPayload(payload voiceCatalogRefreshPayload) voiceCatalogRefreshPayload {
	request := normalizeVoiceCatalogRefreshRequest(voiceCatalogRefreshRequest{
		Scope: payload.Scope, Mode: payload.Mode, SourceIDs: payload.SourceIDs,
	})
	payload.Scope = request.Scope
	payload.Mode = request.Mode
	payload.SourceIDs = request.SourceIDs
	return payload
}

func (s *Server) enqueueVoiceCatalogRefresh(ctx context.Context, payload voiceCatalogRefreshPayload, previous voiceCatalogRefreshState, reason string) (voiceCatalogRefreshState, error) {
	payload = normalizeVoiceCatalogRefreshPayload(payload)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, voiceCatalogRefreshWorkflow, "Refresh voice catalog", "Refresh a voice actor's remote catalog and known-work metadata in one recoverable workflow.", voiceCatalogWorkflowDefinition())
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, voiceCatalogRefreshWorkflow, "Refresh voice catalog", "queued", "detail_view", reason, payload, map[string]any{
		"person_id": payload.PersonID, "generation": payload.Generation, "queries": payload.Queries,
		"scope": payload.Scope, "mode": payload.Mode, "source_ids": payload.SourceIDs,
	})
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	remote := voiceCatalogRefreshIncludesRemote(payload.Scope)
	metadata := voiceCatalogRefreshIncludesMetadata(payload.Scope)
	selectStatus := "skipped"
	if remote {
		selectStatus = "succeeded"
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_voice_aliases", DisplayName: "Select confirmed voice names", Position: 1,
		Status: selectStatus, Input: map[string]any{"person_id": payload.PersonID}, Output: map[string]any{"queries": payload.Queries},
	}); err != nil {
		return voiceCatalogRefreshState{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Discover remote voice works", Position: 2,
		Status: map[bool]string{true: "queued", false: "skipped"}[remote], Input: map[string]any{"queries": payload.Queries, "page_size": voiceRemotePageSize, "mode": payload.Mode, "source_ids": payload.SourceIDs},
	})
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "persist", NodeType: "persist_voice_catalog", DisplayName: "Persist voice catalog", Position: 3, Status: map[bool]string{true: "queued", false: "skipped"}[remote]},
		{NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Refresh known-work metadata", Position: 4, Status: map[bool]string{true: "queued", false: "skipped"}[metadata]},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return voiceCatalogRefreshState{}, err
		}
	}
	jobNodeID := discoverNodeID
	resourceKey := "remote:voice-catalog"
	if !remote {
		var metadataNodeID int64
		if err := tx.QueryRowContext(ctx, "SELECT id FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'metadata'", runID).Scan(&metadataNodeID); err != nil {
			return voiceCatalogRefreshState{}, err
		}
		jobNodeID = metadataNodeID
		resourceKey = "metadata:provider"
	}
	_, err = workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: jobNodeID, WorkerType: voiceCatalogRefreshWorker, Status: "queued",
		Priority: workflow.JobPriorityBackground, ResourceKey: resourceKey, Payload: payload,
		Checkpoint: map[string]any{"phase": "queued", "generation": payload.Generation, "scope": payload.Scope, "mode": payload.Mode}, Recoverable: true, MaxRetries: 3,
	})
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	queries := payload.Queries
	if !remote {
		queries = previous.Queries
	}
	queryJSON, err := json.Marshal(queries)
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	sourceJSON, err := json.Marshal(previous.Sources)
	if err != nil {
		return voiceCatalogRefreshState{}, err
	}
	refreshCatalog := 0
	if remote {
		refreshCatalog = 1
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_refresh_state (
			person_id, generation, query_json, source_status_json, last_attempt_at, last_status,
			last_run_id, last_error, complete, pages_fetched, catalog_works, metadata_queued, updated_at
		)
		VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, 'queued', ?, '', 0, 0, 0, 0, CURRENT_TIMESTAMP)
		ON CONFLICT(person_id) DO UPDATE SET
			generation = excluded.generation,
			query_json = excluded.query_json,
			source_status_json = excluded.source_status_json,
			last_attempt_at = CURRENT_TIMESTAMP,
			last_status = 'queued',
			last_run_id = excluded.last_run_id,
			last_error = '',
			complete = CASE WHEN ? = 1 THEN 0 ELSE voice_catalog_refresh_state.complete END,
			pages_fetched = CASE WHEN ? = 1 THEN 0 ELSE voice_catalog_refresh_state.pages_fetched END,
			catalog_works = CASE WHEN ? = 1 THEN 0 ELSE voice_catalog_refresh_state.catalog_works END,
			metadata_queued = 0,
			updated_at = CURRENT_TIMESTAMP
	`, payload.PersonID, payload.Generation, string(queryJSON), string(sourceJSON), runID,
		refreshCatalog, refreshCatalog, refreshCatalog); err != nil {
		return voiceCatalogRefreshState{}, err
	}
	if err := tx.Commit(); err != nil {
		return voiceCatalogRefreshState{}, err
	}
	result := voiceCatalogRefreshState{
		Status: "queued", Reason: reason, LastStatus: "queued", Generation: payload.Generation, RunID: runID,
		Queries: queries, Sources: previous.Sources, LastAttemptAt: time.Now().UTC().Format(time.RFC3339),
		Scope: payload.Scope, Mode: payload.Mode, SourceIDs: append([]int64{}, payload.SourceIDs...),
	}
	if !remote {
		result.LastSuccessAt = previous.LastSuccessAt
		result.Complete = previous.Complete
		result.PagesFetched = previous.PagesFetched
		result.CatalogWorks = previous.CatalogWorks
	}
	return result, nil
}

func voiceCatalogWorkflowDefinition() map[string]any {
	return map[string]any{"nodes": []map[string]string{
		{"id": "select", "type": "select_voice_aliases", "displayName": "Select confirmed voice names"},
		{"id": "discover", "type": "discover_remote_works", "displayName": "Discover remote voice works"},
		{"id": "persist", "type": "persist_voice_catalog", "displayName": "Persist voice catalog"},
		{"id": "metadata", "type": "sync_metadata", "displayName": "Refresh known-work metadata"},
	}}
}

func (s *Server) executeVoiceCatalogRefreshJob(ctx context.Context, job workflowJobRecord) (runErr error) {
	var payload voiceCatalogRefreshPayload
	defer func() {
		if runErr == nil || payload.PersonID <= 0 || payload.Generation <= 0 {
			return
		}
		_ = s.markVoiceCatalogRefreshFailed(context.WithoutCancel(ctx), payload, job.RunID)
	}()
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	payload = normalizeVoiceCatalogRefreshPayload(payload)
	if payload.PersonID <= 0 || payload.Generation <= 0 || (voiceCatalogRefreshIncludesRemote(payload.Scope) && len(payload.Queries) == 0) {
		err := errors.New("voice catalog refresh payload is incomplete")
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if voiceCatalogRefreshIncludesRemote(payload.Scope) {
		if _, err := s.loadPersonName(ctx, payload.PersonID); err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
	}
	previous, err := s.loadVoiceCatalogRefreshState(ctx, payload.PersonID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE voice_catalog_refresh_state
		SET last_status = 'running', last_run_id = ?, updated_at = CURRENT_TIMESTAMP
		WHERE person_id = ? AND generation = ?
	`, job.RunID, payload.PersonID, payload.Generation); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}

	results := []voiceCatalogSourceResult{}
	sourceStatuses := append([]voiceCatalogSourceStatus{}, previous.Sources...)
	pagesFetched := 0
	catalogComplete := previous.Complete
	status := "succeeded"
	remoteStatus := "skipped"
	if voiceCatalogRefreshIncludesRemote(payload.Scope) {
		results, sourceStatuses, pagesFetched, catalogComplete, remoteStatus, err = s.refreshVoiceCatalogSources(ctx, job, payload, previous)
		status = remoteStatus
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
	}

	metadata := voiceCatalogMetadataResult{}
	if voiceCatalogRefreshIncludesMetadata(payload.Scope) {
		metadata, err = s.refreshVoiceCatalogMetadata(ctx, job, nodeIDs, payload, len(results))
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		if metadata.Failed > 0 && status == "succeeded" {
			status = "partial"
		}
	}

	active, err := s.voiceCatalogRefreshRunActive(ctx, payload, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if !active {
		return nil
	}

	catalogWorks, err := s.countVoiceCatalogWorks(ctx, payload.PersonID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if err := s.finishVoiceCatalogRefreshJob(ctx, job, nodeIDs, payload, previous, status, remoteStatus, catalogComplete, sourceStatuses, pagesFetched, catalogWorks, metadata); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if status == "failed" {
		for _, result := range results {
			if result.Err != nil && isRetryableWorkflowError(result.Err) {
				return result.Err
			}
		}
	}
	return nil
}

func (s *Server) refreshVoiceCatalogSources(ctx context.Context, job workflowJobRecord, payload voiceCatalogRefreshPayload, previous voiceCatalogRefreshState) ([]voiceCatalogSourceResult, []voiceCatalogSourceStatus, int, bool, string, error) {
	sources, err := s.resolveVoiceCatalogSources(ctx, payload.SourceIDs)
	if err != nil {
		return nil, nil, 0, false, "failed", err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "discovering", map[string]any{
		"personId": payload.PersonID, "sources": len(sources), "queries": len(payload.Queries), "mode": payload.Mode,
	}, 0, len(sources))

	previousBySource := voiceCatalogSourceStatusByID(previous.Sources)
	results := make([]voiceCatalogSourceResult, len(sources))
	projector := s.remoteCatalogProjector(ctx)
	semaphore := make(chan struct{}, 3)
	var wait sync.WaitGroup
	for index, source := range sources {
		wait.Add(1)
		prior := previousBySource[source.ID]
		go func(index int, source remoteSourceForUse, prior voiceCatalogSourceStatus) {
			defer wait.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			results[index] = s.discoverVoiceCatalogSource(ctx, job.RunID, source, payload.Queries, payload.Mode, prior, projector)
		}(index, source, prior)
	}
	wait.Wait()
	active, err := s.voiceCatalogRefreshRunActive(ctx, payload, job.RunID)
	if err != nil {
		return nil, nil, 0, false, "failed", err
	}
	if !active {
		return results, previous.Sources, 0, previous.Complete, "succeeded", nil
	}

	pagesFetched := 0
	eligibleSources := 0
	successfulSources := 0
	for index, result := range results {
		active, activeErr := s.voiceCatalogRefreshRunActive(ctx, payload, job.RunID)
		if activeErr != nil {
			return nil, nil, 0, false, "failed", activeErr
		}
		if !active {
			return results, previous.Sources, pagesFetched, previous.Complete, "succeeded", nil
		}
		if result.Status.Status != "disabled" && result.Status.Status != "unsupported" {
			eligibleSources++
		}
		if result.Complete {
			successfulSources++
			if _, persistErr := s.persistVoiceCatalogSource(ctx, payload.PersonID, payload.Generation, result, result.Full); persistErr != nil {
				result.Err = persistErr
				result.Complete = false
				result.Status.Status = "error"
				result.Status.Error = "Voice catalog could not be persisted."
				results[index] = result
				successfulSources--
			}
		}
		if result.Err != nil {
			slog.Warn("voice catalog source refresh failed", "run_id", job.RunID, "source_id", result.Source.ID, "error", result.Err)
		}
		pagesFetched += result.Status.Pages
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "persisting", map[string]any{
			"completedSources": index + 1, "sources": len(results), "pagesFetched": pagesFetched,
		}, index+1, len(results))
	}

	status := "succeeded"
	if eligibleSources > 0 && successfulSources == 0 {
		status = "failed"
	} else if successfulSources < eligibleSources {
		status = "partial"
	}
	updates := make([]voiceCatalogSourceStatus, 0, len(results))
	for _, result := range results {
		updates = append(updates, result.Status)
	}
	return results, mergeVoiceCatalogSourceStatuses(previous.Sources, updates), pagesFetched, successfulSources == eligibleSources, status, nil
}

func voiceCatalogSourceStatusByID(statuses []voiceCatalogSourceStatus) map[int64]voiceCatalogSourceStatus {
	result := make(map[int64]voiceCatalogSourceStatus, len(statuses))
	for _, status := range statuses {
		if status.SourceID > 0 {
			result[status.SourceID] = status
		}
	}
	return result
}

func mergeVoiceCatalogSourceStatuses(previous []voiceCatalogSourceStatus, updates []voiceCatalogSourceStatus) []voiceCatalogSourceStatus {
	updateByID := voiceCatalogSourceStatusByID(updates)
	merged := make([]voiceCatalogSourceStatus, 0, len(previous)+len(updates))
	seen := map[int64]bool{}
	for _, status := range previous {
		if update, ok := updateByID[status.SourceID]; ok {
			if len(update.Cursors) == 0 {
				update.Cursors = status.Cursors
			}
			merged = append(merged, update)
			seen[status.SourceID] = true
			continue
		}
		merged = append(merged, status)
		seen[status.SourceID] = true
	}
	for _, update := range updates {
		if update.SourceID <= 0 || seen[update.SourceID] {
			continue
		}
		merged = append(merged, update)
	}
	return merged
}

func (s *Server) refreshVoiceCatalogMetadata(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, payload voiceCatalogRefreshPayload, remoteProgress int) (voiceCatalogMetadataResult, error) {
	targets, err := s.loadVoiceCatalogMetadataTargets(ctx, payload.PersonID)
	if err != nil {
		return voiceCatalogMetadataResult{}, err
	}
	result := voiceCatalogMetadataResult{Targeted: len(targets)}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ?
	`, nodeIDs["metadata"]); err != nil {
		return voiceCatalogMetadataResult{}, err
	}
	for index, target := range targets {
		active, activeErr := s.voiceCatalogRefreshRunActive(ctx, payload, job.RunID)
		if activeErr != nil {
			return voiceCatalogMetadataResult{}, activeErr
		}
		if !active {
			return result, nil
		}
		family, syncErr := s.syncWorkMetadataFamily(ctx, target.FamilyCode)
		if syncErr != nil {
			result.Failed++
			slog.Warn("voice catalog metadata refresh failed", "run_id", job.RunID, "code", target.FamilyCode, "error", syncErr)
		} else if len(family.Failures) > 0 {
			result.Failed++
		} else if len(family.SyncedCodes) > 0 {
			result.Synced++
		} else {
			result.Skipped++
		}
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing_metadata", map[string]any{
			"completedWorks": index + 1, "targetWorks": len(targets), "sourceProgress": remoteProgress,
		}, remoteProgress+index+1, remoteProgress+len(targets))
	}
	return result, nil
}

func (s *Server) loadVoiceCatalogMetadataTargets(ctx context.Context, personID int64) ([]voiceCatalogMetadataTarget, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT COALESCE(NULLIF(logical.canonical_code, ''), known.primary_code)
		FROM voice_catalog_item AS item
		LEFT JOIN work AS linked ON linked.id = item.work_id
		LEFT JOIN work AS by_code ON UPPER(by_code.primary_code) = UPPER(item.primary_code)
		INNER JOIN work AS known ON known.id = COALESCE(linked.id, by_code.id)
		LEFT JOIN work_edition AS edition ON edition.work_id = known.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE item.person_id = ?
		ORDER BY COALESCE(NULLIF(logical.canonical_code, ''), known.primary_code) ASC
	`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	targets := []voiceCatalogMetadataTarget{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			targets = append(targets, voiceCatalogMetadataTarget{FamilyCode: code})
		}
	}
	return targets, rows.Err()
}

func (s *Server) voiceCatalogRefreshRunActive(ctx context.Context, payload voiceCatalogRefreshPayload, runID int64) (bool, error) {
	var status string
	if err := s.db.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&status); err != nil {
		return false, err
	}
	if status == "queued" || status == "running" {
		return true, nil
	}
	if status == "cancelled" {
		clearCatalogComplete := 0
		if voiceCatalogRefreshIncludesRemote(payload.Scope) {
			clearCatalogComplete = 1
		}
		_, err := s.db.ExecContext(context.WithoutCancel(ctx), `
			UPDATE voice_catalog_refresh_state
			SET last_status = 'cancelled', last_attempt_at = CURRENT_TIMESTAMP,
				last_run_id = ?, last_error = 'Voice catalog refresh cancelled.',
				complete = CASE WHEN ? = 1 THEN 0 ELSE complete END, updated_at = CURRENT_TIMESTAMP
			WHERE person_id = ? AND generation = ?
		`, runID, clearCatalogComplete, payload.PersonID, payload.Generation)
		return false, err
	}
	return false, fmt.Errorf("workflow run is %s", status)
}

func (s *Server) markVoiceCatalogRefreshFailed(ctx context.Context, payload voiceCatalogRefreshPayload, runID int64) error {
	clearCatalogComplete := 0
	if voiceCatalogRefreshIncludesRemote(payload.Scope) {
		clearCatalogComplete = 1
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE voice_catalog_refresh_state
		SET last_status = 'failed',
			last_attempt_at = CURRENT_TIMESTAMP,
			last_run_id = ?,
			last_error = 'Voice catalog refresh failed.',
			complete = CASE WHEN ? = 1 THEN 0 ELSE complete END,
			updated_at = CURRENT_TIMESTAMP
		WHERE person_id = ? AND generation = ?
	`, runID, clearCatalogComplete, payload.PersonID, payload.Generation)
	return err
}

func (s *Server) discoverVoiceCatalogSource(ctx context.Context, runID int64, source remoteSourceForUse, queries []string, mode string, previous voiceCatalogSourceStatus, projector remoteCatalogProjector) voiceCatalogSourceResult {
	result := voiceCatalogSourceResult{
		Source: source,
		Status: voiceCatalogSourceStatus{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName,
			Status: "ok", Cursors: append([]voiceCatalogQueryCursor{}, previous.Cursors...),
		},
		Candidates: []voiceCatalogCandidate{},
	}
	if !isKikoeruSourceType(source.SourceType) {
		result.Status.Status = "unsupported"
		return result
	}
	if !source.Enabled {
		result.Status.Status = "disabled"
		return result
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		result.Status.Status = "misconfigured"
		result.Status.Error = "Remote source API endpoint is not configured."
		return result
	}

	started := time.Now()
	sourceCtx, cancel := context.WithTimeout(ctx, voiceCatalogSourceTimeout)
	defer cancel()
	client := s.kikoeruCrawlClientForSource(source)
	candidates := map[string]voiceCatalogCandidate{}
	queryCursors := make([]voiceCatalogQueryCursor, 0, len(queries))
	fullSnapshot := true
	for _, query := range queries {
		keyword := voiceCatalogSearchKeyword(query)
		if keyword == "" {
			continue
		}
		frontier := voiceCatalogCursorFrontier(previous.Cursors, query)
		incremental := mode == "incremental" && len(frontier) > 0
		foundFrontier := false
		sortApplied := true
		nextFrontier := []string{}
		seenPages := map[string]bool{}
		reportedTotal := 0
		for pageNumber := 1; ; pageNumber++ {
			if runID > 0 {
				if err := s.ensureWorkflowRunActive(sourceCtx, runID); err != nil {
					result.Status.Status = "error"
					result.Status.Error = "Voice catalog refresh was cancelled."
					result.Status.ElapsedMS = time.Since(started).Milliseconds()
					return result
				}
			}
			// Recent-added order is the only order used for the incremental boundary.
			// Release dates and work codes are never used as ordering cursors.
			page, err := client.ListWorksSorted(sourceCtx, pageNumber, voiceRemotePageSize, keyword, "create_date", "desc")
			if err != nil {
				result.Err = err
				result.Status.Status, result.Status.Error = voiceRemoteSourceErrorStatus(err, sourceCtx.Err())
				result.Status.ElapsedMS = time.Since(started).Milliseconds()
				_ = s.updateSourceHealth(context.WithoutCancel(ctx), source.ID, "unavailable")
				return result
			}
			result.Status.Pages++
			if !page.SortApplied {
				sortApplied = false
				incremental = false
			}
			if pageNumber == 1 && page.SortApplied {
				nextFrontier = voiceCatalogPageFrontier(page.Works)
			}
			if total := voiceCatalogPaginationTotal(page.Pagination); total > reportedTotal {
				reportedTotal = total
			}
			signature := voiceCatalogPageSignature(page.Works)
			if signature != "" && seenPages[signature] {
				result.Status.Status = "invalid_response"
				result.Status.Error = "Remote source pagination did not advance."
				result.Status.ElapsedMS = time.Since(started).Milliseconds()
				_ = s.updateSourceHealth(context.WithoutCancel(ctx), source.ID, "unavailable")
				return result
			}
			if signature != "" {
				seenPages[signature] = true
			}
			for _, remoteWork := range page.Works {
				candidate, ok, candidateErr := s.voiceCatalogCandidate(sourceCtx, source.ID, remoteWork, projector)
				if candidateErr != nil {
					result.Err = candidateErr
					result.Status.Status = "error"
					result.Status.Error = "Voice catalog matching failed."
					result.Status.ElapsedMS = time.Since(started).Milliseconds()
					return result
				}
				if !ok {
					continue
				}
				key := candidate.CanonicalCode + "\x1f" + candidate.RemoteCode
				if _, exists := candidates[key]; !exists {
					candidates[key] = candidate
				}
			}
			if incremental && voiceCatalogPageContainsFrontier(page.Works, frontier) {
				foundFrontier = true
				break
			}
			if voiceCatalogPageComplete(pageNumber, voiceRemotePageSize, reportedTotal, page) {
				break
			}
			if len(page.Works) == 0 {
				result.Status.Status = "invalid_response"
				result.Status.Error = "Remote source pagination ended before its reported total."
				result.Status.ElapsedMS = time.Since(started).Milliseconds()
				_ = s.updateSourceHealth(context.WithoutCancel(ctx), source.ID, "unavailable")
				return result
			}
		}
		if foundFrontier {
			// Stopping at a prior recent-added boundary is intentionally not a full
			// snapshot, so unseen catalog rows must remain available.
			fullSnapshot = false
		}
		if !sortApplied {
			nextFrontier = nil
		}
		queryCursors = append(queryCursors, voiceCatalogQueryCursor{Query: query, Frontier: nextFrontier})
	}

	result.Candidates = make([]voiceCatalogCandidate, 0, len(candidates))
	canonicalCodes := map[string]bool{}
	for _, candidate := range candidates {
		result.Candidates = append(result.Candidates, candidate)
		canonicalCodes[candidate.CanonicalCode] = true
	}
	sort.Slice(result.Candidates, func(left int, right int) bool {
		if result.Candidates[left].CanonicalCode != result.Candidates[right].CanonicalCode {
			return result.Candidates[left].CanonicalCode < result.Candidates[right].CanonicalCode
		}
		return result.Candidates[left].RemoteCode < result.Candidates[right].RemoteCode
	})
	result.Status.Total = len(canonicalCodes)
	result.Status.Matches = len(canonicalCodes)
	result.Status.Cursors = queryCursors
	result.Status.ElapsedMS = time.Since(started).Milliseconds()
	result.Complete = true
	result.Full = fullSnapshot
	_ = s.updateSourceHealth(context.WithoutCancel(ctx), source.ID, "healthy")
	return result
}

func voiceCatalogSearchKeyword(query string) string {
	query = strings.Map(func(value rune) rune {
		if value == '$' || value < ' ' || value == 0x7f {
			return ' '
		}
		return value
	}, strings.TrimSpace(query))
	query = strings.Join(strings.Fields(query), " ")
	if query == "" {
		return ""
	}
	return "$va:" + query + "$"
}

func (s *Server) voiceCatalogCandidate(ctx context.Context, sourceID int64, work kikoeru.Work, projector remoteCatalogProjector) (voiceCatalogCandidate, bool, error) {
	projection := projector.project(sourceID, work)
	remoteCode := normalizeDLsiteCode(projection.RemoteCode)
	if remoteCode == "" {
		return voiceCatalogCandidate{}, false, nil
	}
	ref, err := s.canonicalWorkForCode(ctx, remoteCode)
	if err != nil {
		return voiceCatalogCandidate{}, false, err
	}
	canonicalCode := remoteCode
	if ref.Code != "" {
		canonicalCode = ref.Code
	}
	raw, err := json.Marshal(work)
	if err != nil {
		return voiceCatalogCandidate{}, false, err
	}
	return voiceCatalogCandidate{
		CanonicalCode: canonicalCode, WorkID: ref.WorkID, RemoteCode: remoteCode,
		Projection: projection, RawJSON: string(raw),
	}, true, nil
}

func voiceCatalogPaginationTotal(pagination kikoeru.Pagination) int {
	for _, total := range []int{pagination.TotalCount, pagination.Total, pagination.Count} {
		if total > 0 {
			return total
		}
	}
	return 0
}

func voiceCatalogPageComplete(pageNumber int, requestedPageSize int, reportedTotal int, page kikoeru.WorksPage) bool {
	pageSize := page.Pagination.PageSize
	if pageSize <= 0 {
		pageSize = requestedPageSize
	}
	currentPage := page.Pagination.CurrentPage
	if currentPage <= 0 {
		currentPage = page.Pagination.Page
	}
	if currentPage <= 0 {
		currentPage = pageNumber
	}
	if reportedTotal > 0 {
		return currentPage*pageSize >= reportedTotal
	}
	return len(page.Works) < requestedPageSize
}

func voiceCatalogPageSignature(works []kikoeru.Work) string {
	if len(works) == 0 {
		return ""
	}
	var signature strings.Builder
	for _, work := range works {
		signature.WriteString(normalizedRemoteWorkCode(work))
		signature.WriteByte(':')
		fmt.Fprint(&signature, work.ID)
		signature.WriteByte('|')
	}
	return signature.String()
}

func voiceCatalogCursorFrontier(cursors []voiceCatalogQueryCursor, query string) []string {
	for _, cursor := range cursors {
		if strings.EqualFold(strings.TrimSpace(cursor.Query), strings.TrimSpace(query)) {
			return append([]string{}, cursor.Frontier...)
		}
	}
	return nil
}

func voiceCatalogPageFrontier(works []kikoeru.Work) []string {
	frontier := make([]string, 0, len(works))
	seen := map[string]bool{}
	for _, work := range works {
		identity := voiceCatalogRemoteIdentity(work)
		if identity == "" || seen[identity] {
			continue
		}
		seen[identity] = true
		frontier = append(frontier, identity)
	}
	return frontier
}

func voiceCatalogPageContainsFrontier(works []kikoeru.Work, frontier []string) bool {
	if len(frontier) == 0 {
		return false
	}
	known := make(map[string]bool, len(frontier))
	for _, identity := range frontier {
		known[identity] = true
	}
	for _, work := range works {
		if known[voiceCatalogRemoteIdentity(work)] {
			return true
		}
	}
	return false
}

func voiceCatalogRemoteIdentity(work kikoeru.Work) string {
	if work.ID > 0 {
		return fmt.Sprintf("id:%d", work.ID)
	}
	if code := normalizedRemoteWorkCode(work); code != "" {
		return "code:" + code
	}
	return ""
}

func (s *Server) persistVoiceCatalogSource(ctx context.Context, personID int64, generation int64, result voiceCatalogSourceResult, fullSnapshot bool) ([]int64, error) {
	if !result.Complete {
		return []int64{}, nil
	}
	providerID, err := s.metadataProviderID(ctx, "kikoeru_source_"+result.Source.Code, result.Source.DisplayName)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	knownWorkIDs := map[int64]bool{}
	for _, candidate := range result.Candidates {
		tagsJSON, err := json.Marshal(candidate.Projection.Tags)
		if err != nil {
			return nil, err
		}
		voiceActorsJSON, err := json.Marshal(candidate.Projection.VoiceActors)
		if err != nil {
			return nil, err
		}
		var workID any
		if candidate.WorkID > 0 {
			workID = candidate.WorkID
			knownWorkIDs[candidate.WorkID] = true
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO voice_catalog_item (
				person_id, primary_code, work_id, title, release_date, cover_url, source_url,
				circle, age_rating, rating_average, rating_count, sales_count, current_price,
				tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
				last_seen_at, updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'catalog', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			ON CONFLICT(person_id, primary_code) DO UPDATE SET
				work_id = COALESCE(excluded.work_id, voice_catalog_item.work_id),
				title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE voice_catalog_item.title END,
				release_date = COALESCE(excluded.release_date, voice_catalog_item.release_date),
				cover_url = CASE WHEN excluded.cover_url <> '' THEN excluded.cover_url ELSE voice_catalog_item.cover_url END,
				source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE voice_catalog_item.source_url END,
				circle = CASE WHEN excluded.circle <> '' THEN excluded.circle ELSE voice_catalog_item.circle END,
				age_rating = CASE WHEN excluded.age_rating <> '' THEN excluded.age_rating ELSE voice_catalog_item.age_rating END,
				rating_average = COALESCE(excluded.rating_average, voice_catalog_item.rating_average),
				rating_count = COALESCE(excluded.rating_count, voice_catalog_item.rating_count),
				sales_count = COALESCE(excluded.sales_count, voice_catalog_item.sales_count),
				current_price = COALESCE(excluded.current_price, voice_catalog_item.current_price),
				tags_json = CASE WHEN excluded.tags_json <> '[]' THEN excluded.tags_json ELSE voice_catalog_item.tags_json END,
				voice_actors_json = CASE WHEN excluded.voice_actors_json <> '[]' THEN excluded.voice_actors_json ELSE voice_catalog_item.voice_actors_json END,
				raw_json = excluded.raw_json,
				catalog_status = 'catalog',
				snapshot_generation = excluded.snapshot_generation,
				last_seen_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
		`, personID, candidate.CanonicalCode, workID, firstNonEmpty(candidate.Projection.Title, candidate.CanonicalCode),
			nullableCatalogText(candidate.Projection.ReleaseDate), candidate.Projection.CoverURL, candidate.Projection.SourceURL,
			candidate.Projection.Circle, candidate.Projection.AgeRating, candidate.Projection.Rating,
			candidate.Projection.RatingCount, candidate.Projection.Sales, candidate.Projection.Price,
			string(tagsJSON), string(voiceActorsJSON), candidate.RawJSON, generation); err != nil {
			return nil, err
		}
		var catalogItemID int64
		if err := tx.QueryRowContext(ctx, `
			SELECT id FROM voice_catalog_item WHERE person_id = ? AND primary_code = ?
		`, personID, candidate.CanonicalCode).Scan(&catalogItemID); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO voice_catalog_source (
				catalog_item_id, provider_id, remote_id, remote_code, source_url,
				availability, raw_json, snapshot_generation, last_seen_at, last_checked_at, updated_at
			)
			VALUES (?, ?, ?, ?, ?, 'available', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			ON CONFLICT(catalog_item_id, provider_id, remote_code) DO UPDATE SET
				remote_id = excluded.remote_id,
				source_url = excluded.source_url,
				availability = 'available',
				raw_json = excluded.raw_json,
				snapshot_generation = excluded.snapshot_generation,
				last_seen_at = CURRENT_TIMESTAMP,
				last_checked_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
		`, catalogItemID, providerID, candidate.Projection.RemoteID, candidate.RemoteCode,
			candidate.Projection.SourceURL, candidate.RawJSON, generation); err != nil {
			return nil, err
		}
		if candidate.WorkID > 0 {
			if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
				WorkID: candidate.WorkID, FileSourceID: result.Source.ID, PresenceType: sourcePresenceTypeRemoteSource,
				RemoteID: candidate.Projection.RemoteID, RemoteCode: candidate.RemoteCode,
				SourceURL: candidate.Projection.SourceURL, Availability: "available",
				RawJSON: mustJSON(map[string]any{"source": "voice_catalog", "primary_code": candidate.CanonicalCode, "remote_code": candidate.RemoteCode}),
			}); err != nil {
				return nil, err
			}
		}
	}
	if fullSnapshot {
		if _, err := tx.ExecContext(ctx, `
			UPDATE voice_catalog_source
			SET availability = 'not_found', last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
			WHERE provider_id = ?
				AND snapshot_generation <> ?
				AND availability = 'available'
				AND catalog_item_id IN (SELECT id FROM voice_catalog_item WHERE person_id = ?)
		`, providerID, generation, personID); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_source_presence
			SET availability = 'missing', last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
			WHERE file_source_id = ?
				AND presence_type = ?
				AND availability = 'available'
				AND json_extract(raw_json, '$.source') = 'voice_catalog'
				AND EXISTS (
					SELECT 1
					FROM voice_catalog_source AS catalog_source
					INNER JOIN voice_catalog_item AS catalog_item ON catalog_item.id = catalog_source.catalog_item_id
					WHERE catalog_item.person_id = ?
						AND catalog_item.work_id = work_source_presence.work_id
						AND catalog_source.provider_id = ?
						AND UPPER(catalog_source.remote_code) = UPPER(work_source_presence.remote_code)
						AND catalog_source.availability = 'not_found'
				)
		`, result.Source.ID, sourcePresenceTypeRemoteSource, personID, providerID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	workIDs := make([]int64, 0, len(knownWorkIDs))
	for workID := range knownWorkIDs {
		workIDs = append(workIDs, workID)
	}
	sort.Slice(workIDs, func(left int, right int) bool { return workIDs[left] < workIDs[right] })
	return workIDs, nil
}

func loadVoiceCatalogPersonSnapshot(ctx context.Context, tx *sql.Tx, personID int64) (voiceCatalogPersonSnapshot, error) {
	snapshot := voiceCatalogPersonSnapshot{Items: []voiceCatalogItemSnapshot{}}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, primary_code, work_id, title, release_date, cover_url, source_url,
			circle, age_rating, rating_average, rating_count, sales_count, current_price,
			tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
			last_seen_at, created_at, updated_at
		FROM voice_catalog_item
		WHERE person_id = ?
		ORDER BY primary_code, id
	`, personID)
	if err != nil {
		return snapshot, err
	}
	type itemWithID struct {
		id   int64
		item voiceCatalogItemSnapshot
	}
	items := []itemWithID{}
	for rows.Next() {
		var row itemWithID
		var workID, ratingCount, salesCount, currentPrice sql.NullInt64
		var releaseDate sql.NullString
		var ratingAverage sql.NullFloat64
		if err := rows.Scan(
			&row.id, &row.item.PrimaryCode, &workID, &row.item.Title, &releaseDate,
			&row.item.CoverURL, &row.item.SourceURL, &row.item.Circle, &row.item.AgeRating,
			&ratingAverage, &ratingCount, &salesCount, &currentPrice, &row.item.TagsJSON,
			&row.item.VoiceActorsJSON, &row.item.RawJSON, &row.item.CatalogStatus,
			&row.item.SnapshotGeneration, &row.item.LastSeenAt, &row.item.CreatedAt, &row.item.UpdatedAt,
		); err != nil {
			_ = rows.Close()
			return snapshot, err
		}
		row.item.WorkID = voiceCatalogInt64Pointer(workID)
		row.item.ReleaseDate = voiceCatalogStringPointer(releaseDate)
		row.item.RatingAverage = voiceCatalogFloat64Pointer(ratingAverage)
		row.item.RatingCount = voiceCatalogInt64Pointer(ratingCount)
		row.item.SalesCount = voiceCatalogInt64Pointer(salesCount)
		row.item.CurrentPrice = voiceCatalogInt64Pointer(currentPrice)
		row.item.Sources = []voiceCatalogSourceSnapshot{}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return snapshot, err
	}
	if err := rows.Close(); err != nil {
		return snapshot, err
	}
	for _, row := range items {
		sourceRows, err := tx.QueryContext(ctx, `
			SELECT provider_id, remote_id, remote_code, source_url, availability,
				raw_json, snapshot_generation, last_seen_at, last_checked_at, created_at, updated_at
			FROM voice_catalog_source
			WHERE catalog_item_id = ?
			ORDER BY provider_id, remote_code, id
		`, row.id)
		if err != nil {
			return snapshot, err
		}
		for sourceRows.Next() {
			var source voiceCatalogSourceSnapshot
			if err := sourceRows.Scan(
				&source.ProviderID, &source.RemoteID, &source.RemoteCode, &source.SourceURL,
				&source.Availability, &source.RawJSON, &source.SnapshotGeneration, &source.LastSeenAt,
				&source.LastCheckedAt, &source.CreatedAt, &source.UpdatedAt,
			); err != nil {
				_ = sourceRows.Close()
				return snapshot, err
			}
			row.item.Sources = append(row.item.Sources, source)
		}
		if err := sourceRows.Err(); err != nil {
			_ = sourceRows.Close()
			return snapshot, err
		}
		if err := sourceRows.Close(); err != nil {
			return snapshot, err
		}
		snapshot.Items = append(snapshot.Items, row.item)
	}

	var refresh voiceCatalogRefreshStateSnapshot
	var lastSuccess, lastAttempt sql.NullString
	var lastRunID sql.NullInt64
	var complete int
	err = tx.QueryRowContext(ctx, `
		SELECT generation, query_json, source_status_json, last_success_at, last_attempt_at,
			last_status, last_run_id, last_error, complete, pages_fetched, catalog_works,
			metadata_queued, updated_at
		FROM voice_catalog_refresh_state
		WHERE person_id = ?
	`, personID).Scan(
		&refresh.Generation, &refresh.QueryJSON, &refresh.SourceStatusJSON, &lastSuccess,
		&lastAttempt, &refresh.LastStatus, &lastRunID, &refresh.LastError, &complete,
		&refresh.PagesFetched, &refresh.CatalogWorks, &refresh.MetadataQueued, &refresh.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, err
	}
	refresh.LastSuccessAt = voiceCatalogStringPointer(lastSuccess)
	refresh.LastAttemptAt = voiceCatalogStringPointer(lastAttempt)
	refresh.LastRunID = voiceCatalogInt64Pointer(lastRunID)
	refresh.Complete = complete != 0
	snapshot.Refresh = &refresh
	return snapshot, nil
}

func mergeVoiceCatalogPeople(ctx context.Context, tx *sql.Tx, targetID int64, sourceID int64) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_item (
			person_id, primary_code, work_id, title, release_date, cover_url, source_url,
			circle, age_rating, rating_average, rating_count, sales_count, current_price,
			tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
			last_seen_at, created_at, updated_at
		)
		SELECT ?, primary_code, work_id, title, release_date, cover_url, source_url,
			circle, age_rating, rating_average, rating_count, sales_count, current_price,
			tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
			last_seen_at, created_at, updated_at
		FROM voice_catalog_item
		WHERE person_id = ?
		ON CONFLICT(person_id, primary_code) DO UPDATE SET
			work_id = COALESCE(voice_catalog_item.work_id, excluded.work_id),
			title = COALESCE(NULLIF(voice_catalog_item.title, ''), excluded.title),
			release_date = COALESCE(voice_catalog_item.release_date, excluded.release_date),
			cover_url = COALESCE(NULLIF(voice_catalog_item.cover_url, ''), excluded.cover_url),
			source_url = COALESCE(NULLIF(voice_catalog_item.source_url, ''), excluded.source_url),
			circle = COALESCE(NULLIF(voice_catalog_item.circle, ''), excluded.circle),
			age_rating = COALESCE(NULLIF(voice_catalog_item.age_rating, ''), excluded.age_rating),
			rating_average = COALESCE(voice_catalog_item.rating_average, excluded.rating_average),
			rating_count = COALESCE(voice_catalog_item.rating_count, excluded.rating_count),
			sales_count = COALESCE(voice_catalog_item.sales_count, excluded.sales_count),
			current_price = COALESCE(voice_catalog_item.current_price, excluded.current_price),
			tags_json = CASE WHEN voice_catalog_item.tags_json = '[]' THEN excluded.tags_json ELSE voice_catalog_item.tags_json END,
			voice_actors_json = CASE WHEN voice_catalog_item.voice_actors_json = '[]' THEN excluded.voice_actors_json ELSE voice_catalog_item.voice_actors_json END,
			raw_json = CASE WHEN voice_catalog_item.raw_json = '{}' THEN excluded.raw_json ELSE voice_catalog_item.raw_json END,
			snapshot_generation = MAX(voice_catalog_item.snapshot_generation, excluded.snapshot_generation),
			last_seen_at = MAX(voice_catalog_item.last_seen_at, excluded.last_seen_at),
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_source (
			catalog_item_id, provider_id, remote_id, remote_code, source_url, availability,
			raw_json, snapshot_generation, last_seen_at, last_checked_at, created_at, updated_at
		)
		SELECT target_item.id, source.provider_id, source.remote_id, source.remote_code,
			source.source_url, source.availability, source.raw_json, source.snapshot_generation,
			source.last_seen_at, source.last_checked_at, source.created_at, source.updated_at
		FROM voice_catalog_source AS source
		INNER JOIN voice_catalog_item AS source_item ON source_item.id = source.catalog_item_id
		INNER JOIN voice_catalog_item AS target_item
			ON target_item.person_id = ? AND target_item.primary_code = source_item.primary_code
		WHERE source_item.person_id = ?
		ON CONFLICT(catalog_item_id, provider_id, remote_code) DO UPDATE SET
			remote_id = COALESCE(NULLIF(voice_catalog_source.remote_id, ''), excluded.remote_id),
			source_url = COALESCE(NULLIF(voice_catalog_source.source_url, ''), excluded.source_url),
			availability = CASE
				WHEN voice_catalog_source.availability = 'available' OR excluded.availability = 'available' THEN 'available'
				WHEN excluded.last_checked_at > voice_catalog_source.last_checked_at THEN excluded.availability
				ELSE voice_catalog_source.availability
			END,
			raw_json = CASE WHEN voice_catalog_source.raw_json = '{}' THEN excluded.raw_json ELSE voice_catalog_source.raw_json END,
			snapshot_generation = MAX(voice_catalog_source.snapshot_generation, excluded.snapshot_generation),
			last_seen_at = MAX(voice_catalog_source.last_seen_at, excluded.last_seen_at),
			last_checked_at = MAX(voice_catalog_source.last_checked_at, excluded.last_checked_at),
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_refresh_state WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_item WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE voice_catalog_refresh_state
		SET query_json = '[]', source_status_json = '[]', last_success_at = NULL,
			last_attempt_at = NULL, last_status = 'stale', last_run_id = NULL,
			last_error = '', complete = 0, pages_fetched = 0,
			catalog_works = (SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = ?),
			metadata_queued = 0, updated_at = CURRENT_TIMESTAMP
		WHERE person_id = ?
	`, targetID, targetID); err != nil {
		return err
	}
	return nil
}

func restoreVoiceCatalogMergeSnapshot(
	ctx context.Context,
	tx *sql.Tx,
	targetID int64,
	sourceID int64,
	targetSnapshot voiceCatalogPersonSnapshot,
	sourceSnapshot voiceCatalogPersonSnapshot,
) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_refresh_state WHERE person_id IN (?, ?)", targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_item WHERE person_id IN (?, ?)", targetID, sourceID); err != nil {
		return err
	}
	if err := restoreVoiceCatalogPersonSnapshot(ctx, tx, targetID, targetSnapshot); err != nil {
		return err
	}
	return restoreVoiceCatalogPersonSnapshot(ctx, tx, sourceID, sourceSnapshot)
}

func restoreVoiceCatalogPersonSnapshot(ctx context.Context, tx *sql.Tx, personID int64, snapshot voiceCatalogPersonSnapshot) error {
	for _, item := range snapshot.Items {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO voice_catalog_item (
				person_id, primary_code, work_id, title, release_date, cover_url, source_url,
				circle, age_rating, rating_average, rating_count, sales_count, current_price,
				tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
				last_seen_at, created_at, updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, personID, item.PrimaryCode, item.WorkID, item.Title, item.ReleaseDate, item.CoverURL,
			item.SourceURL, item.Circle, item.AgeRating, item.RatingAverage, item.RatingCount,
			item.SalesCount, item.CurrentPrice, item.TagsJSON, item.VoiceActorsJSON, item.RawJSON,
			item.CatalogStatus, item.SnapshotGeneration, item.LastSeenAt, item.CreatedAt, item.UpdatedAt)
		if err != nil {
			return err
		}
		catalogItemID, err := result.LastInsertId()
		if err != nil {
			return err
		}
		for _, source := range item.Sources {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO voice_catalog_source (
					catalog_item_id, provider_id, remote_id, remote_code, source_url,
					availability, raw_json, snapshot_generation, last_seen_at, last_checked_at,
					created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`, catalogItemID, source.ProviderID, source.RemoteID, source.RemoteCode,
				source.SourceURL, source.Availability, source.RawJSON, source.SnapshotGeneration,
				source.LastSeenAt, source.LastCheckedAt, source.CreatedAt, source.UpdatedAt); err != nil {
				return err
			}
		}
	}
	if snapshot.Refresh == nil {
		return nil
	}
	refresh := snapshot.Refresh
	complete := 0
	if refresh.Complete {
		complete = 1
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_refresh_state (
			person_id, generation, query_json, source_status_json, last_success_at,
			last_attempt_at, last_status, last_run_id, last_error, complete, pages_fetched,
			catalog_works, metadata_queued, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, personID, refresh.Generation, refresh.QueryJSON, refresh.SourceStatusJSON,
		refresh.LastSuccessAt, refresh.LastAttemptAt, refresh.LastStatus, refresh.LastRunID,
		refresh.LastError, complete, refresh.PagesFetched, refresh.CatalogWorks,
		refresh.MetadataQueued, refresh.UpdatedAt)
	return err
}

func voiceCatalogStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func voiceCatalogInt64Pointer(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func voiceCatalogFloat64Pointer(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func nullableCatalogText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func (s *Server) countVoiceCatalogWorks(ctx context.Context, personID int64) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = ?", personID).Scan(&count)
	return count, err
}

func (s *Server) finishVoiceCatalogRefreshJob(
	ctx context.Context,
	job workflowJobRecord,
	nodeIDs map[string]int64,
	payload voiceCatalogRefreshPayload,
	previous voiceCatalogRefreshState,
	status string,
	remoteStatus string,
	catalogComplete bool,
	sourceStatuses []voiceCatalogSourceStatus,
	pagesFetched int,
	catalogWorks int,
	metadata voiceCatalogMetadataResult,
) error {
	remoteScope := voiceCatalogRefreshIncludesRemote(payload.Scope)
	metadataScope := voiceCatalogRefreshIncludesMetadata(payload.Scope)
	if !remoteScope {
		sourceStatuses = append([]voiceCatalogSourceStatus{}, previous.Sources...)
		catalogComplete = previous.Complete
		pagesFetched = previous.PagesFetched
		catalogWorks = previous.CatalogWorks
	}
	sourceJSON, err := json.Marshal(sourceStatuses)
	if err != nil {
		return err
	}
	remoteError := ""
	if remoteStatus == "failed" {
		remoteError = "Remote source catalog refresh failed."
	} else if remoteStatus == "partial" {
		remoteError = "Some remote sources could not be refreshed."
	}
	metadataError := ""
	if metadata.Failed > 0 {
		metadataError = "Some known-work metadata could not be refreshed."
	}
	lastError := remoteError
	if lastError == "" {
		lastError = metadataError
	}
	metadataProcessed := metadata.Synced + metadata.Skipped + metadata.Failed
	summary := map[string]any{
		"person_id": payload.PersonID, "generation": payload.Generation, "queries": payload.Queries,
		"status": status, "scope": payload.Scope, "mode": payload.Mode, "source_ids": payload.SourceIDs,
		"sources": sourceStatuses, "pages_fetched": pagesFetched, "catalog_works": catalogWorks,
		"metadata_targeted": metadata.Targeted, "metadata_synced": metadata.Synced,
		"metadata_skipped": metadata.Skipped, "metadata_failed": metadata.Failed,
		"metadata_processed": metadataProcessed,
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	complete := 0
	if catalogComplete {
		complete = 1
	}
	remoteSucceeded := 0
	if remoteScope && catalogComplete {
		remoteSucceeded = 1
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE voice_catalog_refresh_state
		SET source_status_json = ?,
			last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
			last_attempt_at = CURRENT_TIMESTAMP,
			last_status = ?,
			last_run_id = ?,
			last_error = ?,
			complete = ?,
			pages_fetched = ?,
			catalog_works = ?,
			metadata_queued = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE person_id = ? AND generation = ?
	`, string(sourceJSON), remoteSucceeded, time.Now().UTC().Format(time.RFC3339), status, job.RunID, lastError,
		complete, pagesFetched, catalogWorks, metadataProcessed, payload.PersonID, payload.Generation); err != nil {
		return err
	}
	if remoteScope {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = ?, output_json = ?, error_message = ?,
				started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, remoteStatus, mustJSON(map[string]any{
			"sources": sourceStatuses, "pages_fetched": pagesFetched, "mode": payload.Mode,
		}), remoteError, nodeIDs["discover"]); err != nil {
			return err
		}
		persistStatus := remoteStatus
		if remoteStatus == "failed" {
			persistStatus = "skipped"
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = ?, output_json = ?, error_message = ?,
				started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, persistStatus, mustJSON(map[string]any{
			"catalog_works": catalogWorks, "generation": payload.Generation,
		}), remoteError, nodeIDs["persist"]); err != nil {
			return err
		}
	}
	if metadataScope {
		metadataStatus := "succeeded"
		if metadata.Failed > 0 {
			metadataStatus = "partial"
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = ?, output_json = ?, error_message = ?,
				started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, metadataStatus, mustJSON(map[string]any{
			"targeted": metadata.Targeted, "synced": metadata.Synced,
			"skipped": metadata.Skipped, "failed": metadata.Failed,
		}), metadataError, nodeIDs["metadata"]); err != nil {
			return err
		}
	}
	jobStatus := "succeeded"
	if status == "failed" {
		jobStatus = "failed"
	}
	remoteProgress := 0
	if remoteScope {
		remoteProgress = len(payload.SourceIDs)
	}
	progressCurrent := remoteProgress + metadataProcessed
	progressTotal := remoteProgress
	if metadataScope {
		progressTotal += metadata.Targeted
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL,
			checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, jobStatus, progressCurrent, progressTotal, lastError,
		mustJSON(map[string]any{"phase": "completed", "detail": summary, "progressCurrent": progressCurrent, "progressTotal": progressTotal}), job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, status, mustJSON(summary), job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: eventLevelForWorkflowStatus(status),
		Type: "voice_catalog_refresh.completed", Message: "Voice catalog refresh " + status, Detail: summary,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

// loadVoiceCatalogMatches returns the persisted source catalog, including
// negative observations from a completed refresh. A source failure never
// removes its previous rows; the source status explains whether those rows are
// current or stale to the caller.
func (s *Server) loadVoiceCatalogMatches(ctx context.Context, personID int64) ([]voiceRemoteSourceSet, error) {
	state, err := s.currentVoiceCatalogRefreshState(ctx, personID)
	if err != nil {
		return nil, err
	}
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	sets := make([]voiceRemoteSourceSet, 0, len(sources))
	setIndexes := map[int64]int{}
	for _, source := range sources {
		status := voiceCatalogSourceSetStatus(source, state)
		setIndexes[source.ID] = len(sets)
		sets = append(sets, voiceRemoteSourceSet{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName,
			Status: status, Works: []voiceRemoteWork{},
		})
	}

	demoWhere := ""
	if s.cfg.IsDemo() {
		demoWhere = `
			AND EXISTS (
				SELECT 1
				FROM work AS demo_work
				WHERE (demo_work.id = item.work_id OR UPPER(demo_work.primary_code) = UPPER(item.primary_code))
					AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
			)
		`
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			item.primary_code, item.work_id, item.title, item.release_date, item.cover_url,
			item.source_url, item.circle, item.age_rating, item.rating_average,
			item.rating_count, item.sales_count, item.current_price, item.tags_json,
			item.voice_actors_json, file_source.id, catalog_source.remote_id, catalog_source.remote_code,
			catalog_source.source_url, catalog_source.availability, catalog_source.last_seen_at,
			file_source.code, file_source.display_name
		FROM voice_catalog_item AS item
		INNER JOIN voice_catalog_source AS catalog_source ON catalog_source.catalog_item_id = item.id
		INNER JOIN metadata_provider AS provider ON provider.id = catalog_source.provider_id
		INNER JOIN file_source ON provider.code = 'kikoeru_source_' || file_source.code
			AND file_source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
		WHERE item.person_id = ?
			`+demoWhere+`
		ORDER BY item.primary_code ASC, file_source.id ASC, catalog_source.remote_code ASC
	`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	workRefs := map[string]canonicalWorkRef{}
	availabilityBySource := map[string]sourceAvailabilityState{}
	for rows.Next() {
		var primaryCode, title, coverURL, itemSourceURL, circle, ageRating string
		var tagsJSON, voiceActorsJSON string
		var remoteID, remoteCode, sourceURL, availability, lastSeen, sourceCode, sourceName string
		var itemWorkID, sourceID sql.NullInt64
		var releaseDate sql.NullString
		var rating, ratingCount, sales, price sql.NullFloat64
		if err := rows.Scan(
			&primaryCode, &itemWorkID, &title, &releaseDate, &coverURL, &itemSourceURL, &circle,
			&ageRating, &rating, &ratingCount, &sales, &price, &tagsJSON, &voiceActorsJSON,
			&sourceID, &remoteID, &remoteCode, &sourceURL, &availability, &lastSeen, &sourceCode, &sourceName,
		); err != nil {
			return nil, err
		}
		if !sourceID.Valid || sourceID.Int64 <= 0 {
			continue
		}
		index, ok := setIndexes[sourceID.Int64]
		if !ok {
			index = len(sets)
			setIndexes[sourceID.Int64] = index
			sets = append(sets, voiceRemoteSourceSet{
				SourceID: sourceID.Int64, SourceCode: sourceCode, DisplayName: sourceName,
				Status: "ok", Works: []voiceRemoteWork{},
			})
		}
		code := strings.ToUpper(strings.TrimSpace(primaryCode))
		if code == "" {
			continue
		}
		workID := catalogWorkID(itemWorkID)
		if workID == 0 {
			known, cached := workRefs[code]
			if !cached {
				var resolveErr error
				known, resolveErr = s.canonicalWorkForCode(ctx, code)
				if resolveErr != nil {
					return nil, resolveErr
				}
				workRefs[code] = known
			}
			if known.WorkID > 0 {
				workID = known.WorkID
			}
		}
		var tags, voiceActors []string
		_ = json.Unmarshal([]byte(tagsJSON), &tags)
		_ = json.Unmarshal([]byte(voiceActorsJSON), &voiceActors)
		if tags == nil {
			tags = []string{}
		}
		if voiceActors == nil {
			voiceActors = []string{}
		}
		flags := sourceAvailabilityState{}
		if workID > 0 && sourceID.Int64 > 0 {
			availabilityKey := fmt.Sprintf("%d:%s", sourceID.Int64, code)
			var cached bool
			flags, cached = availabilityBySource[availabilityKey]
			if !cached {
				flags, err = s.sourceAvailabilityFlags(ctx, sourceID.Int64, code)
				if err != nil {
					return nil, err
				}
				availabilityBySource[availabilityKey] = flags
			}
		}
		status := voiceSourceAvailabilityStatus(availability)
		status = voiceCatalogObservationStatus(status, sets[index].Status)
		if status == "unknown" && strings.TrimSpace(lastSeen) != "" {
			status = "available"
		}
		remoteWork := voiceRemoteWork{
			SourceID: sourceID.Int64, SourceCode: sourceCode, SourceName: sourceName,
			RemoteID: remoteID, PrimaryCode: code, RemoteCode: strings.TrimSpace(remoteCode),
			Title: firstNonEmpty(title, code), ReleaseDate: voiceCatalogStringValue(releaseDate),
			UpdatedAt: voiceCatalogStringValue(releaseDate), CoverURL: coverURL,
			Circle: circle, AgeRating: ageRating, Rating: nullableFloat64FromNull(rating),
			RatingCount: nullableInt64FromFloatNull(ratingCount), Sales: nullableInt64FromFloatNull(sales),
			Price: nullableInt64FromFloatNull(price), Tags: tags, VoiceActors: voiceActors,
			ImportStatus: remoteImportStatus(nullableWorkID(workID)), RemotePlayable: status == "available",
			WorkID: nullableWorkID(workID), HasLocal: flags.HasLocal, HasCache: flags.HasCache,
			HasRemote: flags.HasRemote || status == "available", Availability: status,
		}
		sets[index].Works = append(sets[index].Works, remoteWork)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range sets {
		if sourceStatus, ok := voiceCatalogSourceStatusForID(state.Sources, sets[index].SourceID); ok {
			sets[index].Total = sourceStatus.Total
			sets[index].ElapsedMS = sourceStatus.ElapsedMS
			sets[index].Error = sourceStatus.Error
			if sets[index].Status == "pending" {
				sets[index].Status = sourceStatusToSetStatus(sourceStatus.Status)
			}
		}
		if sets[index].Total == 0 {
			sets[index].Total = distinctRemoteCatalogCodes(sets[index].Works)
		}
	}
	return sets, nil
}

func voiceCatalogSourceSetStatus(source remoteSourceForUse, state voiceCatalogRefreshState) string {
	if !isKikoeruSourceType(source.SourceType) {
		return "unsupported"
	}
	if !source.Enabled {
		return "disabled"
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return "misconfigured"
	}
	if state.Status == "queued" || state.Status == "running" {
		return "refreshing"
	}
	if status, ok := voiceCatalogSourceStatusForID(state.Sources, source.ID); ok {
		return sourceStatusToSetStatus(status.Status)
	}
	return "pending"
}

func sourceStatusToSetStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "ok", "succeeded", "catalog_synced":
		return "ok"
	case "disabled":
		return "disabled"
	case "unsupported":
		return "unsupported"
	case "pending", "queued", "running":
		return "refreshing"
	default:
		return status
	}
}

func voiceCatalogObservationStatus(availability string, sourceStatus string) string {
	switch strings.ToLower(strings.TrimSpace(sourceStatus)) {
	case "disabled":
		return "disabled"
	case "unsupported", "misconfigured":
		return "unavailable"
	default:
		return availability
	}
}

func voiceCatalogSourceStatusForID(statuses []voiceCatalogSourceStatus, sourceID int64) (voiceCatalogSourceStatus, bool) {
	for _, status := range statuses {
		if status.SourceID == sourceID {
			return status, true
		}
	}
	return voiceCatalogSourceStatus{}, false
}

func distinctRemoteCatalogCodes(works []voiceRemoteWork) int {
	seen := map[string]bool{}
	for _, work := range works {
		code := strings.ToUpper(strings.TrimSpace(work.PrimaryCode))
		if code != "" {
			seen[code] = true
		}
	}
	return len(seen)
}

func catalogWorkID(value sql.NullInt64) int64 {
	if value.Valid {
		return value.Int64
	}
	return 0
}

func nullableWorkID(value int64) *int64 {
	if value <= 0 {
		return nil
	}
	return &value
}

func nullableFloat64FromNull(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func nullableInt64FromFloatNull(value sql.NullFloat64) *int64 {
	if !value.Valid {
		return nil
	}
	converted := int64(value.Float64)
	return &converted
}
