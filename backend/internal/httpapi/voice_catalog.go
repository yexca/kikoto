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

// refreshVoiceCatalog queues the voice actor follow workflow with its new-works
// step off, so a detail refresh and a Workflows run share one pipeline.
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
	inputs := map[string]any{
		"personId": personID, "catalogRefresh": request.CatalogRefresh, "metadataRefresh": request.MetadataRefresh, "newWorks": false,
	}
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
		inputs["sourceIds"] = sourceIDs
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
		_ = s.markVoiceCatalogRefreshFailed(context.WithoutCancel(ctx), payload, progress.runID)
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
		cursor, queryFull, stop := s.discoverVoiceCatalogQuery(sourceCtx, runID, source, client, query, keyword, mode, previous, projector, started, &result, candidates)
		if stop {
			return result
		}
		queryCursors = append(queryCursors, cursor)
		if !queryFull {
			fullSnapshot = false
		}
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

func (s *Server) discoverVoiceCatalogQuery(sourceCtx context.Context, runID int64, source remoteSourceForUse, client *kikoeru.Client, query, keyword, mode string, previous voiceCatalogSourceStatus, projector remoteCatalogProjector, started time.Time, result *voiceCatalogSourceResult, candidates map[string]voiceCatalogCandidate) (voiceCatalogQueryCursor, bool, bool) {
	state := newVoiceCatalogQueryState(mode, previous, query)
	for pageNumber := 1; ; pageNumber++ {
		if runID > 0 {
			if err := s.ensureWorkflowRunActive(sourceCtx, runID); err != nil {
				result.Status.Status, result.Status.Error = "error", "Voice catalog refresh was cancelled."
				result.Status.ElapsedMS = time.Since(started).Milliseconds()
				return voiceCatalogQueryCursor{}, false, true
			}
		}
		// Recent-added order is the only order used for the incremental boundary.
		// Release dates and work codes are never used as ordering cursors.
		page, err := client.ListWorksSorted(sourceCtx, pageNumber, voiceRemotePageSize, keyword, "create_date", "desc")
		if err != nil {
			result.Err = err
			result.Status.Status, result.Status.Error = voiceRemoteSourceErrorStatus(err, sourceCtx.Err())
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			_ = s.updateSourceHealth(context.WithoutCancel(sourceCtx), source.ID, "unavailable")
			return voiceCatalogQueryCursor{}, false, true
		}
		result.Status.Pages++
		duplicate := state.observePage(pageNumber, page)
		if duplicate {
			result.Status.Status, result.Status.Error = "invalid_response", "Remote source pagination did not advance."
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			_ = s.updateSourceHealth(context.WithoutCancel(sourceCtx), source.ID, "unavailable")
			return voiceCatalogQueryCursor{}, false, true
		}
		if err := s.addVoiceCatalogPageCandidates(sourceCtx, source.ID, page.Works, projector, candidates); err != nil {
			result.Err = err
			result.Status.Status, result.Status.Error = "error", "Voice catalog matching failed."
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			return voiceCatalogQueryCursor{}, false, true
		}
		if state.incremental && voiceCatalogPageContainsFrontier(page.Works, state.frontier) {
			return voiceCatalogQueryCursor{Query: query, Frontier: state.nextFrontier}, false, false
		}
		if voiceCatalogPageComplete(pageNumber, voiceRemotePageSize, state.reportedTotal, page) {
			break
		}
		if len(page.Works) == 0 {
			result.Status.Status, result.Status.Error = "invalid_response", "Remote source pagination ended before its reported total."
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			_ = s.updateSourceHealth(context.WithoutCancel(sourceCtx), source.ID, "unavailable")
			return voiceCatalogQueryCursor{}, false, true
		}
	}
	if !state.sortApplied {
		state.nextFrontier = nil
	}
	return voiceCatalogQueryCursor{Query: query, Frontier: state.nextFrontier}, true, false
}

type voiceCatalogQueryState struct {
	frontier      []string
	incremental   bool
	sortApplied   bool
	nextFrontier  []string
	seenPages     map[string]bool
	reportedTotal int
}

func newVoiceCatalogQueryState(mode string, previous voiceCatalogSourceStatus, query string) voiceCatalogQueryState {
	frontier := voiceCatalogCursorFrontier(previous.Cursors, query)
	return voiceCatalogQueryState{
		frontier: frontier, incremental: mode == "incremental" && len(frontier) > 0,
		sortApplied: true, nextFrontier: []string{}, seenPages: map[string]bool{},
	}
}

func (state *voiceCatalogQueryState) observePage(pageNumber int, page kikoeru.WorksPage) bool {
	if !page.SortApplied {
		state.sortApplied, state.incremental = false, false
	}
	if pageNumber == 1 && page.SortApplied {
		state.nextFrontier = voiceCatalogPageFrontier(page.Works)
	}
	if total := voiceCatalogPaginationTotal(page.Pagination); total > state.reportedTotal {
		state.reportedTotal = total
	}
	signature := voiceCatalogPageSignature(page.Works)
	if signature != "" && state.seenPages[signature] {
		return true
	}
	if signature != "" {
		state.seenPages[signature] = true
	}
	return false
}

func (s *Server) addVoiceCatalogPageCandidates(ctx context.Context, sourceID int64, works []kikoeru.Work, projector remoteCatalogProjector, candidates map[string]voiceCatalogCandidate) error {
	for _, remoteWork := range works {
		candidate, ok, err := s.voiceCatalogCandidate(ctx, sourceID, remoteWork, projector)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		key := candidate.CanonicalCode + "\x1f" + candidate.RemoteCode
		if _, exists := candidates[key]; !exists {
			candidates[key] = candidate
		}
	}
	return nil
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
		if err := persistVoiceCatalogCandidate(ctx, tx, personID, generation, providerID, result.Source.ID, candidate); err != nil {
			return nil, err
		}
		if candidate.WorkID > 0 {
			knownWorkIDs[candidate.WorkID] = true
		}
	}
	if fullSnapshot {
		if err := markStaleVoiceCatalogSourceSnapshot(ctx, tx, personID, generation, providerID, result.Source.ID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return sortedVoiceCatalogWorkIDs(knownWorkIDs), nil
}

func persistVoiceCatalogCandidate(ctx context.Context, tx *sql.Tx, personID, generation, providerID, sourceID int64, candidate voiceCatalogCandidate) error {
	catalogItemID, err := upsertVoiceCatalogItem(ctx, tx, personID, generation, candidate)
	if err != nil {
		return err
	}
	if err := upsertVoiceCatalogSourceRow(ctx, tx, catalogItemID, providerID, generation, candidate); err != nil {
		return err
	}
	if candidate.WorkID <= 0 {
		return nil
	}
	return upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID: candidate.WorkID, FileSourceID: sourceID, PresenceType: sourcePresenceTypeRemoteSource,
		RemoteID: candidate.Projection.RemoteID, RemoteCode: candidate.RemoteCode,
		SourceURL: candidate.Projection.SourceURL, Availability: "available",
		RawJSON: mustJSON(map[string]any{"source": "voice_catalog", "primary_code": candidate.CanonicalCode, "remote_code": candidate.RemoteCode}),
	})
}

func upsertVoiceCatalogItem(ctx context.Context, tx *sql.Tx, personID, generation int64, candidate voiceCatalogCandidate) (int64, error) {
	tagsJSON, err := json.Marshal(candidate.Projection.Tags)
	if err != nil {
		return 0, err
	}
	voiceActorsJSON, err := json.Marshal(candidate.Projection.VoiceActors)
	if err != nil {
		return 0, err
	}
	var workID any
	if candidate.WorkID > 0 {
		workID = candidate.WorkID
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
		return 0, err
	}
	var catalogItemID int64
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM voice_catalog_item WHERE person_id = ? AND primary_code = ?
	`, personID, candidate.CanonicalCode).Scan(&catalogItemID)
	return catalogItemID, err
}

func upsertVoiceCatalogSourceRow(ctx context.Context, tx *sql.Tx, catalogItemID, providerID, generation int64, candidate voiceCatalogCandidate) error {
	_, err := tx.ExecContext(ctx, `
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
		candidate.Projection.SourceURL, candidate.RawJSON, generation)
	return err
}

func markStaleVoiceCatalogSourceSnapshot(ctx context.Context, tx *sql.Tx, personID, generation, providerID, sourceID int64) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE voice_catalog_source
		SET availability = 'not_found', last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE provider_id = ?
			AND snapshot_generation <> ?
			AND availability = 'available'
			AND catalog_item_id IN (SELECT id FROM voice_catalog_item WHERE person_id = ?)
	`, providerID, generation, personID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
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
	`, sourceID, sourcePresenceTypeRemoteSource, personID, providerID)
	return err
}

func sortedVoiceCatalogWorkIDs(known map[int64]bool) []int64 {
	workIDs := make([]int64, 0, len(known))
	for workID := range known {
		workIDs = append(workIDs, workID)
	}
	sort.Slice(workIDs, func(left int, right int) bool { return workIDs[left] < workIDs[right] })
	return workIDs
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

type voiceCatalogRefreshOutcome struct {
	status            string
	remoteStatus      string
	remoteScope       bool
	metadataScope     bool
	catalogComplete   bool
	sourceStatuses    []voiceCatalogSourceStatus
	sourceJSON        string
	pagesFetched      int
	catalogWorks      int
	metadata          voiceCatalogMetadataResult
	metadataProcessed int
	remoteError       string
	metadataError     string
	lastError         string
	summary           map[string]any
}

func prepareVoiceCatalogRefreshOutcome(
	payload voiceCatalogRefreshPayload,
	previous voiceCatalogRefreshState,
	status string,
	remoteStatus string,
	catalogComplete bool,
	sourceStatuses []voiceCatalogSourceStatus,
	pagesFetched int,
	catalogWorks int,
	metadata voiceCatalogMetadataResult,
) (voiceCatalogRefreshOutcome, error) {
	remoteScope := voiceCatalogRefreshIncludesRemote(payload.Scope)
	if !remoteScope {
		sourceStatuses = append([]voiceCatalogSourceStatus{}, previous.Sources...)
		catalogComplete = previous.Complete
		pagesFetched = previous.PagesFetched
		catalogWorks = previous.CatalogWorks
	}
	sourceJSON, err := json.Marshal(sourceStatuses)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	remoteError := ""
	switch remoteStatus {
	case "failed":
		remoteError = "Remote source catalog refresh failed."
	case "partial":
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
	return voiceCatalogRefreshOutcome{
		status:            status,
		remoteStatus:      remoteStatus,
		remoteScope:       remoteScope,
		metadataScope:     voiceCatalogRefreshIncludesMetadata(payload.Scope),
		catalogComplete:   catalogComplete,
		sourceStatuses:    sourceStatuses,
		sourceJSON:        string(sourceJSON),
		pagesFetched:      pagesFetched,
		catalogWorks:      catalogWorks,
		metadata:          metadata,
		metadataProcessed: metadataProcessed,
		remoteError:       remoteError,
		metadataError:     metadataError,
		lastError:         lastError,
		summary: map[string]any{
			"person_id": payload.PersonID, "generation": payload.Generation, "queries": payload.Queries,
			"status": status, "scope": payload.Scope, "mode": payload.Mode, "source_ids": payload.SourceIDs,
			"sources": sourceStatuses, "pages_fetched": pagesFetched, "catalog_works": catalogWorks,
			"metadata_targeted": metadata.Targeted, "metadata_synced": metadata.Synced,
			"metadata_skipped": metadata.Skipped, "metadata_failed": metadata.Failed,
			"metadata_processed": metadataProcessed,
		},
	}, nil
}

func persistVoiceCatalogRefreshOutcome(
	ctx context.Context,
	tx *sql.Tx,
	runID int64,
	payload voiceCatalogRefreshPayload,
	outcome voiceCatalogRefreshOutcome,
) error {
	complete := 0
	if outcome.catalogComplete {
		complete = 1
	}
	remoteSucceeded := 0
	if outcome.remoteScope && outcome.catalogComplete {
		remoteSucceeded = 1
	}
	_, err := tx.ExecContext(ctx, `
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
	`, outcome.sourceJSON, remoteSucceeded, time.Now().UTC().Format(time.RFC3339), outcome.status, runID, outcome.lastError,
		complete, outcome.pagesFetched, outcome.catalogWorks, outcome.metadataProcessed, payload.PersonID, payload.Generation)
	return err
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
	sets, setIndexes := initialVoiceCatalogSourceSets(sources, state)
	sets, err = s.loadVoiceCatalogMatchRows(ctx, personID, sets, setIndexes)
	if err != nil {
		return nil, err
	}
	applyVoiceCatalogSourceState(sets, state)
	return sets, nil
}

func initialVoiceCatalogSourceSets(sources []remoteSourceForUse, state voiceCatalogRefreshState) ([]voiceRemoteSourceSet, map[int64]int) {
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
	return sets, setIndexes
}

func (s *Server) loadVoiceCatalogMatchRows(ctx context.Context, personID int64, sets []voiceRemoteSourceSet, setIndexes map[int64]int) ([]voiceRemoteSourceSet, error) {
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
		row, err := scanVoiceCatalogMatchRow(rows)
		if err != nil {
			return nil, err
		}
		if !row.SourceID.Valid || row.SourceID.Int64 <= 0 {
			continue
		}
		index, ok := setIndexes[row.SourceID.Int64]
		if !ok {
			index = len(sets)
			setIndexes[row.SourceID.Int64] = index
			sets = append(sets, voiceRemoteSourceSet{
				SourceID: row.SourceID.Int64, SourceCode: row.SourceCode, DisplayName: row.SourceName,
				Status: "ok", Works: []voiceRemoteWork{},
			})
		}
		code := strings.ToUpper(strings.TrimSpace(row.PrimaryCode))
		if code == "" {
			continue
		}
		remoteWork, err := s.buildVoiceCatalogRemoteWork(ctx, row, code, sets[index].Status, workRefs, availabilityBySource)
		if err != nil {
			return nil, err
		}
		sets[index].Works = append(sets[index].Works, remoteWork)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return sets, nil
}

func applyVoiceCatalogSourceState(sets []voiceRemoteSourceSet, state voiceCatalogRefreshState) {
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
}

type voiceCatalogMatchRow struct {
	PrimaryCode, Title, CoverURL, ItemSourceURL, Circle, AgeRating string
	TagsJSON, VoiceActorsJSON                                      string
	RemoteID, RemoteCode, SourceURL, Availability, LastSeen        string
	SourceCode, SourceName                                         string
	ItemWorkID, SourceID                                           sql.NullInt64
	ReleaseDate                                                    sql.NullString
	Rating, RatingCount, Sales, Price                              sql.NullFloat64
}

func scanVoiceCatalogMatchRow(rows *sql.Rows) (voiceCatalogMatchRow, error) {
	var row voiceCatalogMatchRow
	err := rows.Scan(
		&row.PrimaryCode, &row.ItemWorkID, &row.Title, &row.ReleaseDate, &row.CoverURL, &row.ItemSourceURL, &row.Circle,
		&row.AgeRating, &row.Rating, &row.RatingCount, &row.Sales, &row.Price, &row.TagsJSON, &row.VoiceActorsJSON,
		&row.SourceID, &row.RemoteID, &row.RemoteCode, &row.SourceURL, &row.Availability, &row.LastSeen, &row.SourceCode, &row.SourceName,
	)
	return row, err
}

func (s *Server) buildVoiceCatalogRemoteWork(ctx context.Context, row voiceCatalogMatchRow, code, sourceStatus string, workRefs map[string]canonicalWorkRef, availabilityBySource map[string]sourceAvailabilityState) (voiceRemoteWork, error) {
	workID := catalogWorkID(row.ItemWorkID)
	if workID == 0 {
		known, cached := workRefs[code]
		if !cached {
			var err error
			known, err = s.canonicalWorkForCode(ctx, code)
			if err != nil {
				return voiceRemoteWork{}, err
			}
			workRefs[code] = known
		}
		if known.WorkID > 0 {
			workID = known.WorkID
		}
	}
	tags := decodeVoiceCatalogStrings(row.TagsJSON)
	voiceActors := decodeVoiceCatalogStrings(row.VoiceActorsJSON)
	flags := sourceAvailabilityState{}
	if workID > 0 && row.SourceID.Int64 > 0 {
		availabilityKey := fmt.Sprintf("%d:%s", row.SourceID.Int64, code)
		var cached bool
		flags, cached = availabilityBySource[availabilityKey]
		if !cached {
			var err error
			flags, err = s.sourceAvailabilityFlags(ctx, row.SourceID.Int64, code)
			if err != nil {
				return voiceRemoteWork{}, err
			}
			availabilityBySource[availabilityKey] = flags
		}
	}
	status := voiceSourceAvailabilityStatus(row.Availability)
	status = voiceCatalogObservationStatus(status, sourceStatus)
	if status == "unknown" && strings.TrimSpace(row.LastSeen) != "" {
		status = "available"
	}
	return voiceRemoteWork{
		SourceID: row.SourceID.Int64, SourceCode: row.SourceCode, SourceName: row.SourceName,
		RemoteID: row.RemoteID, PrimaryCode: code, RemoteCode: strings.TrimSpace(row.RemoteCode),
		Title: firstNonEmpty(row.Title, code), ReleaseDate: voiceCatalogStringValue(row.ReleaseDate),
		UpdatedAt: voiceCatalogStringValue(row.ReleaseDate), CoverURL: row.CoverURL,
		Circle: row.Circle, AgeRating: row.AgeRating, Rating: nullableFloat64FromNull(row.Rating),
		RatingCount: nullableInt64FromFloatNull(row.RatingCount), Sales: nullableInt64FromFloatNull(row.Sales),
		Price: nullableInt64FromFloatNull(row.Price), Tags: tags, VoiceActors: voiceActors,
		ImportStatus: remoteImportStatus(nullableWorkID(workID)), RemotePlayable: status == "available",
		WorkID: nullableWorkID(workID), HasLocal: flags.HasLocal, HasCache: flags.HasCache,
		HasRemote: flags.HasRemote || status == "available", Availability: status,
	}, nil
}

func decodeVoiceCatalogStrings(raw string) []string {
	var values []string
	_ = json.Unmarshal([]byte(raw), &values)
	if values == nil {
		return []string{}
	}
	return values
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
