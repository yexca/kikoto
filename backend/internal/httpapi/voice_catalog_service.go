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
)

const voiceCatalogSourceTimeout = 15 * time.Minute

var errVoiceCatalogNoSourcesSelected = errors.New("select at least one remote source")

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

// voiceCatalogProgress reports catalog refresh progress to the workflow run
// that drives it. The report callback is optional.
type voiceCatalogProgress struct {
	runID  int64
	report func(phase string, detail map[string]any, current int, total int)
}

func (p voiceCatalogProgress) update(phase string, detail map[string]any, current int, total int) {
	if p.report != nil {
		p.report(phase, detail, current, total)
	}
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

// refreshVoiceCatalog queues the voice actor follow workflow with the metadata
// action off, so a detail refresh and a Workflows run share one pipeline. Its
// metadata refresh keeps to the voice actor's known works.
func (s *Server) refreshVoiceCatalog(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	var request creatorRefreshRequest
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice catalog refresh request"})
			return
		}
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	request = request.normalized()
	inputs := presetWorkflowInputs{PersonID: personID, CatalogRefresh: request.CatalogRefresh, KnownMetadata: request.MetadataRefresh != "off"}
	if request.CatalogRefresh != "stored" {
		sourceIDs, err := s.compatibleRemoteSourceIDs(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		if len(sourceIDs) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": errVoiceCatalogNoSourcesSelected.Error()})
			return
		}
		inputs.SourceIDs = sourceIDs
	}
	run, err := s.queueCreatorRefresh(r.Context(), actor, "voice_follow", inputs, func(ctx context.Context) (creatorRefreshRun, bool, error) {
		return s.latestVoiceFollowRun(ctx, personID, true)
	})
	if !s.writeCreatorRefreshError(w, err) {
		return
	}
	state, err := s.loadVoiceCatalogRefreshState(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	state.Status = run.Status
	state.RunID = run.RunID
	writeJSON(w, http.StatusAccepted, state)
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

func (s *Server) voiceCatalogQueries(ctx context.Context, personID int64) ([]string, error) {
	name, err := s.loadPersonName(ctx, personID)
	if err != nil {
		return nil, err
	}
	aliases, err := s.loadVoiceAliases(ctx, personID)
	if err != nil {
		return nil, err
	}
	aliasValues := make([]string, 0, len(aliases))
	for _, alias := range aliases {
		aliasValues = append(aliasValues, alias.Alias)
	}
	return voiceCatalogQueryValues(name, aliasValues), nil
}

func voiceCatalogQueryValues(name string, aliases []string) []string {
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
		appendValue(alias)
	}
	return values
}

func equalVoiceCatalogQuerySets(left []string, right []string) bool {
	leftSet := map[string]bool{}
	for _, value := range left {
		key := voiceNameKey(value)
		if key != "" {
			leftSet[key] = true
		}
	}
	rightSet := map[string]bool{}
	for _, value := range right {
		key := voiceNameKey(value)
		if key != "" {
			rightSet[key] = true
		}
	}
	if len(leftSet) != len(rightSet) {
		return false
	}
	for value := range leftSet {
		if !rightSet[value] {
			return false
		}
	}
	return true
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
	run, ok, err := s.latestVoiceFollowRun(ctx, personID, true)
	if err != nil || !ok {
		return voiceCatalogRefreshState{}, false, err
	}
	state, err := s.loadVoiceCatalogRefreshState(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshState{}, false, err
	}
	state.Status = run.Status
	state.RunID = run.RunID
	return state, true, nil
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

func persistVoiceCatalogRefreshState(ctx context.Context, tx *sql.Tx, payload voiceCatalogRefreshPayload, previous voiceCatalogRefreshState, runID int64, queries []string, remote bool) error {
	queryJSON, err := json.Marshal(queries)
	if err != nil {
		return err
	}
	sourceJSON, err := json.Marshal(previous.Sources)
	if err != nil {
		return err
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
		return err
	}
	return nil
}

func (s *Server) refreshVoiceCatalogSources(ctx context.Context, progress voiceCatalogProgress, payload voiceCatalogRefreshPayload, previous voiceCatalogRefreshState) ([]voiceCatalogSourceResult, []voiceCatalogSourceStatus, int, bool, string, error) {
	sources, err := s.resolveVoiceCatalogSources(ctx, payload.SourceIDs)
	if err != nil {
		return nil, nil, 0, false, "failed", err
	}
	progress.update("discovering", map[string]any{
		"personId": payload.PersonID, "sources": len(sources), "queries": len(payload.Queries), "mode": payload.Mode,
	}, 0, len(sources))
	results := s.discoverVoiceCatalogSources(ctx, progress.runID, sources, payload, previous.Sources)
	active, err := s.voiceCatalogRefreshRunActive(ctx, payload, progress.runID)
	if err != nil {
		return nil, nil, 0, false, "failed", err
	}
	if !active {
		return results, previous.Sources, 0, previous.Complete, "succeeded", nil
	}
	persisted, err := s.persistVoiceCatalogRefreshResults(ctx, progress, payload, results)
	if err != nil {
		return nil, nil, 0, false, "failed", err
	}
	if !persisted.Active {
		return results, previous.Sources, persisted.PagesFetched, previous.Complete, "succeeded", nil
	}
	status := voiceCatalogSourceRefreshStatus(persisted.EligibleSources, persisted.SuccessfulSources)
	return results, mergeVoiceCatalogSourceStatuses(previous.Sources, persisted.Statuses), persisted.PagesFetched, persisted.SuccessfulSources == persisted.EligibleSources, status, nil
}

func (s *Server) discoverVoiceCatalogSources(ctx context.Context, runID int64, sources []remoteSourceForUse, payload voiceCatalogRefreshPayload, previous []voiceCatalogSourceStatus) []voiceCatalogSourceResult {
	previousBySource := voiceCatalogSourceStatusByID(previous)
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
			results[index] = s.discoverVoiceCatalogSource(ctx, runID, source, payload.Queries, payload.Mode, prior, projector)
		}(index, source, prior)
	}
	wait.Wait()
	return results
}

type voiceCatalogSourceRefreshProgress struct {
	PagesFetched      int
	EligibleSources   int
	SuccessfulSources int
	Statuses          []voiceCatalogSourceStatus
	Active            bool
}

func (s *Server) persistVoiceCatalogRefreshResults(ctx context.Context, reporter voiceCatalogProgress, payload voiceCatalogRefreshPayload, results []voiceCatalogSourceResult) (voiceCatalogSourceRefreshProgress, error) {
	progress := voiceCatalogSourceRefreshProgress{Statuses: make([]voiceCatalogSourceStatus, 0, len(results)), Active: true}
	for index := range results {
		active, err := s.voiceCatalogRefreshRunActive(ctx, payload, reporter.runID)
		if err != nil {
			return voiceCatalogSourceRefreshProgress{}, err
		}
		if !active {
			progress.Active = false
			return progress, nil
		}
		result := &results[index]
		if result.Status.Status != "disabled" && result.Status.Status != "unsupported" {
			progress.EligibleSources++
		}
		if result.Complete {
			progress.SuccessfulSources++
			if _, err := s.persistVoiceCatalogSource(ctx, payload.PersonID, payload.Generation, *result, result.Full); err != nil {
				result.Err = err
				result.Complete = false
				result.Status.Status = "error"
				result.Status.Error = "Voice catalog could not be persisted."
				progress.SuccessfulSources--
			}
		}
		if result.Err != nil {
			slog.Warn("voice catalog source refresh failed", "run_id", reporter.runID, "source_id", result.Source.ID, "error", result.Err)
		}
		progress.PagesFetched += result.Status.Pages
		progress.Statuses = append(progress.Statuses, result.Status)
		reporter.update("persisting", map[string]any{
			"completedSources": index + 1, "sources": len(results), "pagesFetched": progress.PagesFetched,
		}, index+1, len(results))
	}
	return progress, nil
}

func voiceCatalogSourceRefreshStatus(eligibleSources, successfulSources int) string {
	if eligibleSources > 0 && successfulSources == 0 {
		return "failed"
	}
	if successfulSources < eligibleSources {
		return "partial"
	}
	return "succeeded"
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

// refreshVoiceCatalogMetadata synchronizes known works of a voice actor's
// catalog. Incremental mode selects works without a provider snapshot; full
// mode selects every known work. Catalog-only rows are never materialized.
func (s *Server) refreshVoiceCatalogMetadata(ctx context.Context, progress voiceCatalogProgress, personID int64, mode string) (voiceCatalogMetadataResult, error) {
	targets, err := s.loadVoiceCatalogMetadataTargets(ctx, personID, mode)
	if err != nil {
		return voiceCatalogMetadataResult{}, err
	}
	result := voiceCatalogMetadataResult{Targeted: len(targets)}
	for index, target := range targets {
		if err := s.ensureWorkflowRunActive(ctx, progress.runID); err != nil {
			return result, err
		}
		family, syncErr := s.syncWorkMetadataFamily(ctx, target.FamilyCode)
		if syncErr != nil {
			result.Failed++
			slog.Warn("voice catalog metadata refresh failed", "run_id", progress.runID, "code", target.FamilyCode, "error", syncErr)
		} else if len(family.Failures) > 0 {
			result.Failed++
		} else if len(family.SyncedCodes) > 0 {
			result.Synced++
		} else {
			result.Skipped++
		}
		progress.update("syncing_metadata", map[string]any{"completedWorks": index + 1, "targetWorks": len(targets)}, index+1, len(targets))
	}
	return result, nil
}

// refreshVoiceCatalogRemote runs one catalog generation for a voice actor
// inside the workflow run that requested it and persists its outcome.
func (s *Server) refreshVoiceCatalogRemote(ctx context.Context, progress voiceCatalogProgress, personID int64, sourceIDs []int64, mode string) (voiceCatalogRefreshOutcome, error) {
	queries, err := s.voiceCatalogQueries(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	if len(queries) == 0 {
		return voiceCatalogRefreshOutcome{status: "skipped"}, nil
	}
	sources, err := s.resolveVoiceCatalogSources(ctx, sourceIDs)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	previous, err := s.loadVoiceCatalogRefreshState(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	payload := normalizeVoiceCatalogRefreshPayload(voiceCatalogRefreshPayload{
		PersonID: personID, Queries: queries, Generation: previous.Generation + 1,
		Scope: "remote", Mode: mode, SourceIDs: voiceCatalogSourceIDs(sources),
	})
	if err := s.startVoiceCatalogGeneration(ctx, payload, previous, progress.runID); err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	_, statuses, pages, complete, remoteStatus, err := s.refreshVoiceCatalogSources(ctx, progress, payload, previous)
	if err != nil {
		if !shutdownInterrupted(ctx) {
			_ = s.markVoiceCatalogRefreshFailed(context.WithoutCancel(ctx), payload, progress.runID)
		}
		return voiceCatalogRefreshOutcome{}, err
	}
	active, err := s.voiceCatalogRefreshRunActive(ctx, payload, progress.runID)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	if !active {
		return voiceCatalogRefreshOutcome{status: "cancelled"}, nil
	}
	catalogWorks, err := s.countVoiceCatalogWorks(ctx, personID)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	outcome, err := prepareVoiceCatalogRefreshOutcome(payload, previous, remoteStatus, remoteStatus, complete, statuses, pages, catalogWorks, voiceCatalogMetadataResult{})
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := persistVoiceCatalogRefreshOutcome(ctx, tx, progress.runID, payload, outcome); err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	return outcome, tx.Commit()
}

func (s *Server) startVoiceCatalogGeneration(ctx context.Context, payload voiceCatalogRefreshPayload, previous voiceCatalogRefreshState, runID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := persistVoiceCatalogRefreshState(ctx, tx, payload, previous, runID, payload.Queries, true); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE voice_catalog_refresh_state SET last_status = 'running', updated_at = CURRENT_TIMESTAMP
		WHERE person_id = ? AND generation = ?
	`, payload.PersonID, payload.Generation); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) loadVoiceCatalogMetadataTargets(ctx context.Context, personID int64, mode string) ([]voiceCatalogMetadataTarget, error) {
	full := 0
	if strings.EqualFold(strings.TrimSpace(mode), "full") {
		full = 1
	}
	rows, err := s.db.QueryContext(ctx, `
		WITH known_catalog AS (
			SELECT DISTINCT
				COALESCE(NULLIF(logical.canonical_code, ''), known.primary_code) AS family_code,
				known.id AS known_work_id,
				logical.id AS logical_work_id
			FROM voice_catalog_item AS item
			LEFT JOIN work AS linked ON linked.id = item.work_id
			LEFT JOIN work AS by_code ON UPPER(by_code.primary_code) = UPPER(item.primary_code)
			INNER JOIN work AS known ON known.id = COALESCE(linked.id, by_code.id)
			LEFT JOIN work_edition AS edition ON edition.work_id = known.id
			LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			WHERE item.person_id = ?
		)
		SELECT DISTINCT family_code
		FROM known_catalog
		WHERE ? = 1
			OR NOT EXISTS (
				SELECT 1
				FROM metadata_snapshot AS snapshot
				INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
				WHERE provider.code = 'dlsite'
					AND (
						snapshot.work_id = known_catalog.known_work_id
						OR EXISTS (
							SELECT 1
							FROM work_edition AS snapshot_edition
							WHERE snapshot_edition.work_id = snapshot.work_id
								AND snapshot_edition.logical_work_id = known_catalog.logical_work_id
						)
					)
			)
		ORDER BY family_code ASC
	`, personID, full)
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
