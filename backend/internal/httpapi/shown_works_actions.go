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
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workcode"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// Two workflows act on the works a person is looking at on the Subscriptions
// page, a recorded ranking order or a release feed page, and only when that
// person asks. Both are incremental: they take only the works that still need
// them. The metadata sync treats the shown codes as explicitly requested
// metadata roots, so it may create their works, as Availability Watch does for
// watched codes. The source check asks the healthy remote sources about each
// code and records the answer as source presence where the code has a work;
// the run summary keeps every answer. A ranking pull or feed refresh starts
// neither.
const (
	shownWorksMetadataSyncWorkflowCode = "shown_works_metadata_sync"
	shownWorksSourceCheckWorkflowCode  = "shown_works_source_check"

	// shownWorksFreshFor is the SQLite modifier for how long synced metadata
	// and a source answer stay fresh, so a second press takes nothing new.
	shownWorksFreshFor = "-1 day"
	// shownWorksMaxCodes bounds the codes one run takes.
	shownWorksMaxCodes                    = 100
	shownWorksSourceCheckMaxFailureStreak = 5
)

var (
	errRankingPageSnapshotNotFound = errors.New("the ranking order is not recorded")
	errShownWorksNoRemoteSource    = errors.New("no remote source can be checked")
)

func shownWorksWorkflowSpec(code string) systemWorkflowSpec {
	if code == shownWorksSourceCheckWorkflowCode {
		return systemWorkflowSpec{
			Code:        shownWorksSourceCheckWorkflowCode,
			Name:        "Check sources of shown works",
			Description: "Ask the remote sources whether they have the shown ranking or release works that are not known to be available.",
			Nodes: []map[string]string{
				{"id": "select", "type": "select_works", "displayName": "Select shown works"},
				{"id": "check", "type": "check_source_availability", "displayName": "Check source availability"},
			},
		}
	}
	return systemWorkflowSpec{
		Code:        shownWorksMetadataSyncWorkflowCode,
		Name:        "Sync metadata of shown works",
		Description: "Sync DLsite metadata for the shown ranking or release works that lack fresh metadata, adding works the library does not know yet.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_works", "displayName": "Select shown works"},
			{"id": "sync", "type": "sync_metadata", "displayName": "Sync family metadata"},
		},
	}
}

type shownWorksActionResult struct {
	RunID  int64  `json:"runId"`
	JobID  int64  `json:"jobId"`
	Status string `json:"status"`
	// Queued is how many codes the run takes; Skipped how many it leaves.
	Queued   int  `json:"queued"`
	Skipped  int  `json:"skipped"`
	Existing bool `json:"existing"`
}

type shownWorksPayload struct {
	RequestedByUserID int64 `json:"requested_by_user_id"`
	// Origin names what was shown: ranking:<snapshot id> or
	// feed:<user id>:<page>:<days>. A request for the same origin joins its
	// queued or running run.
	Origin string   `json:"origin"`
	Codes  []string `json:"codes"`
}

type shownWorksMetadataCheckpoint struct {
	Next        int      `json:"next"`
	Synced      int      `json:"synced"`
	Unavailable int      `json:"unavailable"`
	Failed      []string `json:"failed"`
}

// shownWorksSourceAnswer is one code's answers: the healthy sources that
// have it and those that do not. A source that failed to answer is in neither.
type shownWorksSourceAnswer struct {
	Code      string  `json:"code"`
	Available []int64 `json:"available"`
	Missing   []int64 `json:"missing"`
}

type shownWorksSource struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type shownWorksSourceCheckpoint struct {
	Started   bool                     `json:"started"`
	Sources   []shownWorksSource       `json:"sources"`
	Next      int                      `json:"next"`
	Available int                      `json:"available"`
	Missing   int                      `json:"missing"`
	Failed    int                      `json:"failed"`
	Results   []shownWorksSourceAnswer `json:"results"`
}

// shownWorksAction is one of the two workflows: what a request needs and how
// it picks the codes that still need the run.
type shownWorksAction struct {
	code       string
	permission string
	resource   string
	// due reports whether a code still needs the run.
	due func(ctx context.Context, q workflowTriggerQueryer, code string) (bool, error)
	// precheck refuses a request the run could not serve.
	precheck func(ctx context.Context) error
}

func (s *Server) shownWorksMetadataSync() shownWorksAction {
	return shownWorksAction{
		code: shownWorksMetadataSyncWorkflowCode, permission: "metadata:sync", resource: "metadata:provider",
		due: shownWorkNeedsMetadata,
	}
}

func (s *Server) shownWorksSourceCheck() shownWorksAction {
	return shownWorksAction{
		code: shownWorksSourceCheckWorkflowCode, permission: "remote:track", resource: "remote:availability",
		due: shownWorkNeedsSourceCheck, precheck: s.requireCheckableRemoteSource,
	}
}

// shownWorkNeedsMetadata takes a code without a work, and a work whose DLsite
// metadata is missing or older than a day. A work DLsite does not list is
// settled.
func shownWorkNeedsMetadata(ctx context.Context, q workflowTriggerQueryer, code string) (bool, error) {
	var due bool
	err := q.QueryRowContext(ctx, `
		SELECT NOT EXISTS (
			SELECT 1 FROM work
			WHERE UPPER(work.primary_code) = ?
				AND (
					EXISTS (
						SELECT 1 FROM work_metadata_provider_state AS state
						INNER JOIN metadata_provider AS provider ON provider.id = state.provider_id
						WHERE state.work_id = work.id AND provider.code = 'dlsite' AND state.status = 'not_found'
					)
					OR EXISTS (
						SELECT 1 FROM metadata_snapshot AS snapshot
						INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
						WHERE snapshot.work_id = work.id AND provider.code = 'dlsite'
							AND snapshot.fetched_at >= datetime('now', ?)
					)
				)
		)
	`, code, shownWorksFreshFor).Scan(&due)
	return due, err
}

// shownWorkNeedsSourceCheck takes a code without a work, and a work that is
// not known to be available: one without an available location or source,
// whose remote sources were not asked within the last day.
func shownWorkNeedsSourceCheck(ctx context.Context, q workflowTriggerQueryer, code string) (bool, error) {
	var due bool
	err := q.QueryRowContext(ctx, `
		SELECT NOT EXISTS (
			SELECT 1 FROM work
			WHERE UPPER(work.primary_code) = ?
				AND (
					EXISTS (
						SELECT 1 FROM work_source_presence AS presence
						WHERE presence.work_id = work.id
							AND (presence.availability = 'available'
								OR (presence.presence_type = ? AND presence.last_checked_at >= datetime('now', ?)))
					)
					OR EXISTS (
						SELECT 1 FROM media_file_location AS location
						INNER JOIN media_item AS item ON item.id = location.media_item_id
						WHERE item.work_id = work.id AND location.availability = 'available'
					)
				)
		)
	`, code, sourcePresenceTypeRemoteSource, shownWorksFreshFor).Scan(&due)
	return due, err
}

func (s *Server) requireCheckableRemoteSource(ctx context.Context) error {
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return err
	}
	for _, source := range sources {
		if source.Enabled && isKikoeruSourceType(source.SourceType) && strings.TrimSpace(source.Endpoint.APIURL) != "" {
			return nil
		}
	}
	return errShownWorksNoRemoteSource
}

func (s *Server) createRankingMetadataSyncRun(w http.ResponseWriter, r *http.Request) {
	s.writeRankingShownWorksAction(w, r, s.shownWorksMetadataSync())
}

func (s *Server) createRankingSourceCheckRun(w http.ResponseWriter, r *http.Request) {
	s.writeRankingShownWorksAction(w, r, s.shownWorksSourceCheck())
}

func (s *Server) createReleaseFeedMetadataSyncRun(w http.ResponseWriter, r *http.Request) {
	s.writeReleaseFeedShownWorksAction(w, r, s.shownWorksMetadataSync())
}

func (s *Server) createReleaseFeedSourceCheckRun(w http.ResponseWriter, r *http.Request) {
	s.writeReleaseFeedShownWorksAction(w, r, s.shownWorksSourceCheck())
}

// writeRankingShownWorksAction runs an action over one recorded order of a
// list the account may see, named by `snapshotId`.
func (s *Server) writeRankingShownWorksAction(w http.ResponseWriter, r *http.Request, action shownWorksAction) {
	actor, ok := s.requirePermission(w, r, action.permission)
	if !ok || s.rejectDemoRankingWrite(w) {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ranking id"})
		return
	}
	var request struct {
		SnapshotID int64 `json:"snapshotId"`
	}
	if !decodeShownWorksRequest(w, r, &request) {
		return
	}
	if request.SnapshotID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "snapshotId is required"})
		return
	}
	if _, err := s.loadVisibleRankingList(r.Context(), actor, id); errors.Is(err, errRankingListNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	} else if err != nil {
		writeError(w, err)
		return
	}
	codes, err := rankingPageCodes(r.Context(), s.db, id, request.SnapshotID)
	if err != nil {
		s.writeShownWorksActionResult(w, shownWorksActionResult{}, err)
		return
	}
	result, err := s.enqueueShownWorksAction(r.Context(), action, actor.ID, "ranking:"+strconv.FormatInt(request.SnapshotID, 10), codes)
	s.writeShownWorksActionResult(w, result, err)
}

// writeReleaseFeedShownWorksAction runs an action over one page of the
// account's release feed, named by `page` and `days` as the feed reads it.
func (s *Server) writeReleaseFeedShownWorksAction(w http.ResponseWriter, r *http.Request, action shownWorksAction) {
	actor, ok := s.requirePermission(w, r, action.permission)
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "demo_read_only", "subscriptions are read-only in demo", false)
		return
	}
	var request struct {
		Page int `json:"page"`
		Days int `json:"days"`
	}
	if !decodeShownWorksRequest(w, r, &request) {
		return
	}
	page, days := max(1, request.Page), releaseFeedDaysPerPage(request.Days)
	zone, _ := s.accountTimeZone(r, actor.ID)
	location, err := time.LoadLocation(zone)
	if err != nil {
		location = time.UTC
	}
	feed, err := s.loadReleaseFeed(r.Context(), actor.ID, page, days, location)
	if err != nil {
		writeError(w, err)
		return
	}
	codes := make([]string, 0, len(feed.Families))
	for _, family := range feed.Families {
		codes = append(codes, releaseFeedShownCode(family))
	}
	origin := fmt.Sprintf("feed:%d:%d:%d", actor.ID, page, days)
	result, err := s.enqueueShownWorksAction(r.Context(), action, actor.ID, origin, codes)
	s.writeShownWorksActionResult(w, result, err)
}

func decodeShownWorksRequest(w http.ResponseWriter, r *http.Request, request any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return false
	}
	return true
}

func (s *Server) writeShownWorksActionResult(w http.ResponseWriter, result shownWorksActionResult, err error) {
	switch {
	case errors.Is(err, errRankingPageSnapshotNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, errShownWorksNoRemoteSource):
		writeAPIError(w, http.StatusConflict, "no_remote_source", err.Error(), false)
	case err != nil:
		writeError(w, err)
	case result.RunID == 0 || result.Existing:
		writeJSON(w, http.StatusOK, result)
	default:
		writeJSON(w, http.StatusAccepted, result)
	}
}

// rankingPageCodes lists a recorded order's codes in rank order, or
// errRankingPageSnapshotNotFound when the snapshot is not one of the list's.
func rankingPageCodes(ctx context.Context, q workflowTriggerQueryer, listID, snapshotID int64) ([]string, error) {
	var found bool
	if err := q.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM ranking_snapshot AS snapshot
			INNER JOIN ranking_variant AS variant ON variant.id = snapshot.ranking_variant_id
			WHERE snapshot.id = ? AND variant.ranking_list_id = ?
		)
	`, snapshotID, listID).Scan(&found); err != nil {
		return nil, err
	}
	if !found {
		return nil, errRankingPageSnapshotNotFound
	}
	rows, err := q.QueryContext(ctx, "SELECT UPPER(primary_code) FROM ranking_snapshot_item WHERE snapshot_id = ? ORDER BY rank", snapshotID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, rows.Err()
}

// enqueueShownWorksAction queues a run over the shown codes that still need
// it, at most shownWorksMaxCodes in the order shown. A request for an origin
// whose run is queued or running joins that run; with nothing to take it
// queues no run.
func (s *Server) enqueueShownWorksAction(ctx context.Context, action shownWorksAction, actorID int64, origin string, codes []string) (shownWorksActionResult, error) {
	if action.precheck != nil {
		if err := action.precheck(ctx); err != nil {
			return shownWorksActionResult{}, err
		}
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return shownWorksActionResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	existing := shownWorksActionResult{Existing: true}
	err = tx.QueryRowContext(ctx, `
		SELECT run.id, run.status, COALESCE((
			SELECT job.id FROM workflow_job AS job WHERE job.workflow_run_id = run.id ORDER BY job.id DESC LIMIT 1
		), 0), COALESCE(json_array_length(run.input_json, '$.codes'), 0)
		FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
			AND json_valid(run.input_json) AND json_extract(run.input_json, '$.origin') = ?
		ORDER BY run.id DESC
		LIMIT 1
	`, action.code, origin).Scan(&existing.RunID, &existing.Status, &existing.JobID, &existing.Queued)
	if err == nil {
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return shownWorksActionResult{}, err
	}
	queued := []string{}
	seen := map[string]bool{}
	for _, code := range codes {
		code = strings.ToUpper(strings.TrimSpace(code))
		if seen[code] || len(queued) >= shownWorksMaxCodes || !workflowGraphWorkCodePattern.MatchString(code) || workcode.IsCustom(code) {
			continue
		}
		seen[code] = true
		due, err := action.due(ctx, tx, code)
		if err != nil {
			return shownWorksActionResult{}, err
		}
		if due {
			queued = append(queued, code)
		}
	}
	result := shownWorksActionResult{Status: "succeeded", Queued: len(queued), Skipped: len(codes) - len(queued)}
	if len(queued) == 0 {
		return result, tx.Commit()
	}
	payload := shownWorksPayload{RequestedByUserID: actorID, Origin: origin, Codes: queued}
	var checkpoint any = shownWorksMetadataCheckpoint{Failed: []string{}}
	if action.code == shownWorksSourceCheckWorkflowCode {
		checkpoint = shownWorksSourceCheckpoint{Sources: []shownWorksSource{}, Results: []shownWorksSourceAnswer{}}
	}
	spec := shownWorksWorkflowSpec(action.code)
	definitionID, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.Name, spec.Description, map[string]any{"nodes": spec.Nodes})
	if err != nil {
		return shownWorksActionResult{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, spec.Code, spec.Name, "queued", "manual", "subscriptions_page", payload, map[string]any{})
	if err != nil {
		return shownWorksActionResult{}, err
	}
	selection := map[string]any{"origin": origin, "codes": queued, "skipped": result.Skipped}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: spec.Nodes[0]["id"], NodeType: spec.Nodes[0]["type"], DisplayName: spec.Nodes[0]["displayName"], Position: 1,
		Status: "succeeded", Input: map[string]any{"origin": origin, "shown": len(codes)}, Output: selection,
	}); err != nil {
		return shownWorksActionResult{}, err
	}
	nodeRunID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: spec.Nodes[1]["id"], NodeType: spec.Nodes[1]["type"], DisplayName: spec.Nodes[1]["displayName"], Position: 2,
		Status: "queued", Input: selection,
	})
	if err != nil {
		return shownWorksActionResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: nodeRunID, WorkerType: spec.Code, Status: "queued", Priority: workflow.JobPriorityUserInitiated,
		ResourceKey: action.resource, Payload: payload, Checkpoint: map[string]any{"phase": "queued", "detail": checkpoint},
		Recoverable: true, MaxRetries: 3, ProgressTotal: len(queued),
	})
	if err != nil {
		return shownWorksActionResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return shownWorksActionResult{}, err
	}
	result.RunID, result.JobID, result.Status = runID, jobID, "queued"
	return result, nil
}

func (s *Server) executeShownWorksMetadataSyncJob(ctx context.Context, job workflowJobRecord) error {
	return s.runShownWorksMetadataSync(ctx, job, s.newDLsiteMetadataSyncer(ctx))
}

// runShownWorksMetadataSync synchronizes each code's DLsite family in the
// order shown. A failed code is recorded and the run moves on; a code DLsite
// does not list is settled.
func (s *Server) runShownWorksMetadataSync(ctx context.Context, job workflowJobRecord, syncer dlsiteFamilyMetadataSyncer) error {
	var payload shownWorksPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint := shownWorksMetadataCheckpoint{Failed: []string{}}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	for checkpoint.Next < len(payload.Codes) {
		if err := ctx.Err(); err != nil {
			return err
		}
		code := payload.Codes[checkpoint.Next]
		family, err := syncer.SyncFamily(ctx, code)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		switch {
		case family.RequestedUnavailable:
			checkpoint.Unavailable++
		case err != nil:
			slog.Warn("shown works metadata sync failed", "work_code", code, "run_id", job.RunID, "error", err)
			checkpoint.Failed = append(checkpoint.Failed, code)
		default:
			checkpoint.Synced++
		}
		checkpoint.Next++
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing", checkpoint, checkpoint.Next, len(payload.Codes)); err != nil {
			return err
		}
	}
	status := "succeeded"
	if len(checkpoint.Failed) > 0 {
		status = "partial"
		if checkpoint.Synced+checkpoint.Unavailable == 0 {
			status = "failed"
		}
	}
	summary := map[string]any{
		"origin": payload.Origin, "codes": len(payload.Codes),
		"synced": checkpoint.Synced, "unavailable": checkpoint.Unavailable, "failed": len(checkpoint.Failed),
		"failed_codes": checkpoint.Failed,
	}
	failure := ""
	if len(checkpoint.Failed) > 0 {
		failure = fmt.Sprintf("%d shown works could not be synced", len(checkpoint.Failed))
	}
	return s.finishShownWorksJob(context.WithoutCancel(ctx), job, status, checkpoint, checkpoint.Next, len(payload.Codes), summary,
		failure, "shown_works.metadata_synced", fmt.Sprintf("Synced metadata for %d shown works", checkpoint.Synced))
}

// executeShownWorksSourceCheckJob probes the sources once, then asks the
// healthy ones about each code through the paced crawl lane. After five codes
// in a row that no source answered it stops and leaves the rest unchecked.
func (s *Server) executeShownWorksSourceCheckJob(ctx context.Context, job workflowJobRecord) error {
	var payload shownWorksPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint := shownWorksSourceCheckpoint{Sources: []shownWorksSource{}, Results: []shownWorksSourceAnswer{}}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	healthy, err := s.healthyRemoteSourceIDsForAvailability(ctx, 0)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if !checkpoint.Started {
		sources, err := s.loadRemoteSourcesForAvailability(ctx)
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		for _, source := range sources {
			if healthy[source.ID] {
				checkpoint.Sources = append(checkpoint.Sources, shownWorksSource{ID: source.ID, Name: source.DisplayName})
			}
		}
		checkpoint.Started = true
	}
	summary := func() map[string]any {
		return map[string]any{
			"origin": payload.Origin, "codes": len(payload.Codes),
			"checked": checkpoint.Next, "available": checkpoint.Available, "missing": checkpoint.Missing,
			"failed": checkpoint.Failed, "unchecked": len(payload.Codes) - checkpoint.Next,
			"sources": checkpoint.Sources, "results": checkpoint.Results,
		}
	}
	if len(healthy) == 0 {
		return s.finishShownWorksJob(context.WithoutCancel(ctx), job, "failed", checkpoint, checkpoint.Next, len(payload.Codes), summary(),
			"no remote source answered", "shown_works.sources_checked", "No remote source answered the source check")
	}
	failureStreak := 0
	for checkpoint.Next < len(payload.Codes) {
		if err := ctx.Err(); err != nil {
			return err
		}
		code := payload.Codes[checkpoint.Next]
		response, err := s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, code, 0, healthy, "subscriptions", shownWorksSourceCheckWorkflowCode)
		if ctxErr := ctx.Err(); ctxErr != nil {
			// An interrupted request is not an answer about the work.
			return ctxErr
		}
		if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		}
		answer := shownWorksSourceAnswer{Code: code, Available: []int64{}, Missing: []int64{}}
		for _, source := range response.Sources {
			switch source.Status {
			case "available":
				answer.Available = append(answer.Available, source.SourceID)
			case "not_found":
				answer.Missing = append(answer.Missing, source.SourceID)
			}
		}
		switch {
		case len(answer.Available) > 0:
			checkpoint.Available++
			failureStreak = 0
		case len(answer.Missing) > 0:
			checkpoint.Missing++
			failureStreak = 0
		default:
			checkpoint.Failed++
			failureStreak++
		}
		checkpoint.Results = append(checkpoint.Results, answer)
		checkpoint.Next++
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "checking", checkpoint, checkpoint.Next, len(payload.Codes)); err != nil {
			return err
		}
		if failureStreak >= shownWorksSourceCheckMaxFailureStreak {
			break
		}
	}
	status, failure := "succeeded", ""
	if checkpoint.Failed > 0 || checkpoint.Next < len(payload.Codes) {
		status = "partial"
		failure = fmt.Sprintf("%d shown works could not be checked", checkpoint.Failed+len(payload.Codes)-checkpoint.Next)
	}
	return s.finishShownWorksJob(context.WithoutCancel(ctx), job, status, checkpoint, checkpoint.Next, len(payload.Codes), summary(),
		failure, "shown_works.sources_checked", fmt.Sprintf("%d of %d shown works are on a source", checkpoint.Available, checkpoint.Next))
}

// finishShownWorksJob settles the job, its node, and its run. Guards keep a
// run that was cancelled meanwhile cancelled.
func (s *Server) finishShownWorksJob(ctx context.Context, job workflowJobRecord, status string, checkpoint any, current, total int,
	summary map[string]any, failure, eventType, message string) error {
	output := mustJSON(summary)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?,
			started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, failure, job.NodeRunID}},
		{`UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running'`, []any{status, current, total, failure,
			mustJSON(map[string]any{"phase": "completed", "detail": checkpoint, "progressCurrent": current, "progressTotal": total}), job.ID}},
		{`UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	// The event states the counts; each code's answer stays in the summary.
	detail := map[string]any{}
	for key, value := range summary {
		if key != "results" && key != "failed_codes" {
			detail[key] = value
		}
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: eventLevelForWorkflowStatus(status),
		Type: eventType, Message: message, Detail: detail,
	}); err != nil {
		return err
	}
	return tx.Commit()
}
