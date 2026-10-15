package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// The subscription refresh is one system run for every subscription: it
// refreshes each subscribed catalog once, synchronizes the metadata of codes
// that appeared since the baseline, adds them to the subscribers' feeds, and
// then checks Availability Watch.

const (
	creatorSubscriptionDisplayName = "Refresh subscriptions"
	creatorSubscriptionWorkerType  = "creator_subscription_refresh"
	// creatorSubscriptionMaxNewWorks bounds the metadata requests of one run;
	// codes beyond it stay unseen for the next run.
	creatorSubscriptionMaxNewWorks = 60
	// creatorSubscriptionRecentPull skips a catalog pull when a detail refresh
	// or another run pulled the catalog this recently.
	creatorSubscriptionRecentPull = 6 * time.Hour
	// creatorSubscriptionReleaseGrace is how far before a subscription took
	// effect a work may have been released and still count as new. Older works
	// that surface later, such as through a full catalog refresh, are recorded
	// as seen without a feed entry.
	creatorSubscriptionReleaseGrace = 30 * 24 * time.Hour
)

var errCreatorSubscriptionRunActive = errors.New("a subscription refresh is already active")

type creatorSubscriptionJobPayload struct {
	RequestedByUserID int64 `json:"requestedByUserId,omitempty"`
	AvailabilityWatch bool  `json:"availabilityWatch"`
}

type creatorSubscriptionRunResult struct {
	RunID      int64    `json:"runId"`
	JobID      int64    `json:"jobId"`
	Status     string   `json:"status"`
	Circles    int      `json:"circles"`
	Voices     int      `json:"voices"`
	Refreshed  int      `json:"refreshed"`
	NewWorks   int      `json:"newWorks"`
	FeedItems  int      `json:"feedItems"`
	Deferred   int      `json:"deferred"`
	WatchRunID int64    `json:"watchRunId,omitempty"`
	Failures   []string `json:"failures"`
}

func creatorSubscriptionNodes() []map[string]string {
	return []map[string]string{
		{"id": "catalogs", "type": "creator_catalogs", "displayName": "Refresh subscribed catalogs"},
		{"id": "metadata", "type": "sync_metadata", "displayName": "Sync new work metadata"},
		{"id": "feed", "type": "release_feed", "displayName": "Add new works to feeds"},
		{"id": "watch", "type": "dispatch_child_workflows", "displayName": "Check Availability Watch"},
	}
}

func (s *Server) enqueueCreatorSubscriptionRefresh(ctx context.Context, trigger workflowRunTrigger, requestedBy int64, availabilityWatch bool) (creatorSubscriptionRunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return creatorSubscriptionRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var active int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ? AND status IN ('queued', 'running')
	`, creatorSubscriptionWorkflowCode).Scan(&active); err != nil {
		return creatorSubscriptionRunResult{}, err
	}
	if active > 0 {
		return creatorSubscriptionRunResult{}, errCreatorSubscriptionRunActive
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, creatorSubscriptionWorkflowCode, creatorSubscriptionDisplayName, creatorSubscriptionDescription, map[string]any{"nodes": creatorSubscriptionNodes()})
	if err != nil {
		return creatorSubscriptionRunResult{}, err
	}
	result := creatorSubscriptionRunResult{Status: "queued", Failures: []string{}}
	input := map[string]any{"availability_watch": availabilityWatch}
	if requestedBy > 0 {
		input[workflowRunRequesterKey] = requestedBy
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, creatorSubscriptionWorkflowCode, creatorSubscriptionDisplayName, "queued", trigger.Type, trigger.Reason, input, result)
	if err != nil {
		return creatorSubscriptionRunResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return creatorSubscriptionRunResult{}, err
		}
	}
	var catalogNodeID int64
	for index, node := range creatorSubscriptionNodes() {
		id, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
			NodeID: node["id"], NodeType: node["type"], DisplayName: node["displayName"], Position: index + 1, Status: "queued",
		})
		if err != nil {
			return creatorSubscriptionRunResult{}, err
		}
		if index == 0 {
			catalogNodeID = id
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: catalogNodeID, WorkerType: creatorSubscriptionWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "metadata:provider",
		Payload:    creatorSubscriptionJobPayload{RequestedByUserID: requestedBy, AvailabilityWatch: availabilityWatch},
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: false, MaxRetries: 1,
	})
	if err != nil {
		return creatorSubscriptionRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return creatorSubscriptionRunResult{}, err
	}
	result.RunID, result.JobID = runID, jobID
	return result, nil
}

const creatorSubscriptionDescription = "Refresh subscribed circle and voice actor catalogs, sync the metadata of new works, add them to subscribers' feeds, and check Availability Watch."

type creatorSubscriptionExecution struct {
	result   creatorSubscriptionRunResult
	catalogs []string
	metadata []string
	feed     map[int64][]string
	watch    string
	// failures holds each node's failures; the run lists all of them.
	failures map[string][]string
}

func (execution *creatorSubscriptionExecution) fail(node, message string) {
	if execution.failures == nil {
		execution.failures = map[string][]string{}
	}
	execution.failures[node] = append(execution.failures[node], message)
	execution.result.Failures = append(execution.result.Failures, message)
}

func (s *Server) executeCreatorSubscriptionRefreshJob(ctx context.Context, job workflowJobRecord) error {
	var payload creatorSubscriptionJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Subscription refresh input is invalid")
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	execution := &creatorSubscriptionExecution{
		result: creatorSubscriptionRunResult{RunID: job.RunID, JobID: job.ID, Status: "succeeded", Failures: []string{}},
		feed:   map[int64][]string{},
	}
	if err := s.activateCreatorSubscriptions(ctx); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Subscriptions could not be loaded")
		return err
	}
	if err := s.refreshSubscribedCreatorCatalogs(ctx, job, execution); err != nil {
		if ctx.Err() == nil {
			_ = s.failClaimedWorkflowJob(ctx, job, "Subscribed catalogs could not be refreshed")
		}
		return err
	}
	if err := s.activateCreatorSubscriptions(ctx); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Subscriptions could not be loaded")
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "new_works", execution.result, 0, 0)
	if err := s.processCreatorReleaseCandidates(ctx, job.RunID, s.newDLsiteMetadataSyncer(ctx), execution); err != nil {
		if ctx.Err() == nil {
			_ = s.failClaimedWorkflowJob(ctx, job, "New works could not be added to feeds")
		}
		return err
	}
	if payload.AvailabilityWatch {
		s.dispatchSubscriptionAvailabilityWatch(ctx, job.RunID, execution)
	} else {
		execution.watch = "skipped"
	}
	if len(execution.result.Failures) > 0 {
		execution.result.Status = "partial"
	}
	if err := s.finishCreatorSubscriptionJob(ctx, job, nodeIDs, execution); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Subscription refresh could not be finalized")
		return err
	}
	return nil
}

type subscribedCircle struct {
	partyID  int64
	circleID string
	name     string
}

// refreshSubscribedCreatorCatalogs pulls each subscribed catalog once,
// including the catalogs of pending subscriptions, whose first successful
// pull sets their baseline.
func (s *Server) refreshSubscribedCreatorCatalogs(ctx context.Context, job workflowJobRecord, execution *creatorSubscriptionExecution) error {
	circles, err := s.subscribedCircles(ctx)
	if err != nil {
		return err
	}
	persons, err := s.subscribedVoices(ctx)
	if err != nil {
		return err
	}
	result := &execution.result
	result.Circles, result.Voices = len(circles), len(persons)
	total := len(circles) + len(persons)
	recent := time.Now().UTC().Add(-creatorSubscriptionRecentPull)
	client := s.newDLsiteClient()
	for index, circle := range circles {
		if err := ctx.Err(); err != nil {
			return err
		}
		if s.creatorCatalogPulledSince(ctx, circle.partyID, 0, recent) {
			continue
		}
		if circle.circleID == "" {
			execution.fail("catalogs", circle.name+": circle has no DLsite id")
			continue
		}
		mode, err := s.creatorSubjectPullMode(ctx, circle.partyID, 0)
		if err != nil {
			return err
		}
		if _, err := s.runCircleCatalogRefresh(ctx, circle.partyID, circle.circleID, mode, client); err != nil {
			if shutdownInterrupted(ctx) || ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Warn("subscription circle catalog refresh failed", "circle_id", circle.circleID, "error", err)
			s.recordCircleCatalogRefreshFailure(context.WithoutCancel(ctx), circle.partyID, mode, job.RunID)
			execution.fail("catalogs", circle.circleID+": catalog refresh failed")
			continue
		}
		result.Refreshed++
		execution.catalogs = append(execution.catalogs, circle.circleID)
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "catalogs", result, index+1, total)
	}
	sourceIDs, err := s.compatibleRemoteSourceIDs(ctx)
	if err != nil {
		return err
	}
	for index, personID := range persons {
		if err := ctx.Err(); err != nil {
			return err
		}
		if s.creatorCatalogPulledSince(ctx, 0, personID, recent) {
			continue
		}
		label := fmt.Sprintf("voice %d", personID)
		if name, err := s.loadPersonName(ctx, personID); err == nil && name != "" {
			label = name
		}
		if len(sourceIDs) == 0 {
			execution.fail("catalogs", label+": no compatible remote source")
			continue
		}
		mode, err := s.creatorSubjectPullMode(ctx, 0, personID)
		if err != nil {
			return err
		}
		outcome, err := s.refreshVoiceCatalogRemote(ctx, voiceCatalogProgress{runID: job.RunID}, personID, sourceIDs, mode)
		if err != nil {
			if shutdownInterrupted(ctx) || ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Warn("subscription voice catalog refresh failed", "person_id", personID, "error", err)
			execution.fail("catalogs", label+": catalog refresh failed")
			continue
		}
		if outcome.status == "failed" || outcome.status == "partial" {
			execution.fail("catalogs", label+": some sources failed")
		}
		result.Refreshed++
		execution.catalogs = append(execution.catalogs, label)
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "catalogs", result, len(circles)+index+1, total)
	}
	return nil
}

func (s *Server) creatorCatalogPulledSince(ctx context.Context, partyID, personID int64, since time.Time) bool {
	lastSuccess, err := s.creatorSubjectLastSuccess(ctx, partyID, personID)
	if err != nil || lastSuccess == "" {
		return false
	}
	parsed, err := parseSQLiteTime(lastSuccess)
	return err == nil && parsed.After(since)
}

func (s *Server) subscribedCircles(ctx context.Context) ([]subscribedCircle, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT party.id, party.display_name, COALESCE((
			SELECT external.external_id FROM party_external_id AS external
			INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id AND provider.code = 'dlsite'
			WHERE external.party_id = party.id AND external.id_type = 'maker_id'
			ORDER BY external.is_primary DESC, external.id
			LIMIT 1
		), '')
		FROM party
		WHERE party.id IN (SELECT party_id FROM creator_subscription WHERE party_id IS NOT NULL)
		ORDER BY party.id
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	circles := []subscribedCircle{}
	for rows.Next() {
		var circle subscribedCircle
		if err := rows.Scan(&circle.partyID, &circle.name, &circle.circleID); err != nil {
			return nil, err
		}
		circle.circleID = normalizeMakerID(circle.circleID)
		circles = append(circles, circle)
	}
	return circles, rows.Err()
}

func (s *Server) subscribedVoices(ctx context.Context) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT person_id FROM creator_subscription WHERE person_id IS NOT NULL ORDER BY person_id
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// creatorReleaseCandidate is a code that appeared in an actively subscribed
// catalog after its baseline.
type creatorReleaseCandidate struct {
	code        string
	releaseDate string
	partyIDs    []int64
	personIDs   []int64
}

func (s *Server) creatorReleaseCandidates(ctx context.Context) ([]creatorReleaseCandidate, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT 'circle', item.party_id, UPPER(item.primary_code), COALESCE(item.release_date, '')
		FROM party_catalog_item AS item
		INNER JOIN metadata_provider AS provider ON provider.id = item.provider_id AND provider.code = 'dlsite'
		WHERE item.party_id IN (SELECT party_id FROM creator_subscription WHERE party_id IS NOT NULL AND activated_at IS NOT NULL)
			AND NOT EXISTS (
				SELECT 1 FROM party_release_seen AS seen
				WHERE seen.party_id = item.party_id AND seen.primary_code = UPPER(item.primary_code)
			)
		UNION ALL
		SELECT 'voice', item.person_id, UPPER(item.primary_code), COALESCE(item.release_date, '')
		FROM voice_catalog_item AS item
		WHERE item.person_id IN (SELECT person_id FROM creator_subscription WHERE person_id IS NOT NULL AND activated_at IS NOT NULL)
			AND item.catalog_status <> 'not_found'
			AND NOT EXISTS (
				SELECT 1 FROM person_release_seen AS seen
				WHERE seen.person_id = item.person_id AND seen.primary_code = UPPER(item.primary_code)
			)
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	byCode := map[string]*creatorReleaseCandidate{}
	for rows.Next() {
		var kind, code, releaseDate string
		var subjectID int64
		if err := rows.Scan(&kind, &subjectID, &code, &releaseDate); err != nil {
			return nil, err
		}
		candidate := byCode[code]
		if candidate == nil {
			candidate = &creatorReleaseCandidate{code: code}
			byCode[code] = candidate
		}
		if candidate.releaseDate == "" {
			candidate.releaseDate = normalizeGraphReleaseDate(releaseDate)
		}
		if kind == "circle" {
			candidate.partyIDs = append(candidate.partyIDs, subjectID)
		} else {
			candidate.personIDs = append(candidate.personIDs, subjectID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	candidates := make([]creatorReleaseCandidate, 0, len(byCode))
	for _, candidate := range byCode {
		candidates = append(candidates, *candidate)
	}
	// Newer DLsite codes carry higher numbers, so the newest works are synced
	// first when a run reaches its bound.
	sort.Slice(candidates, func(i, j int) bool {
		if len(candidates[i].code) != len(candidates[j].code) {
			return len(candidates[i].code) > len(candidates[j].code)
		}
		return candidates[i].code > candidates[j].code
	})
	return candidates, nil
}

type creatorReleaseSubscriber struct {
	subscriptionID    int64
	userID            int64
	kind              string
	partyID           int64
	seriesID          string
	personID          int64
	activatedAt       time.Time
	watchAvailability bool
}

func (s *Server) creatorReleaseSubscribers(ctx context.Context, candidate creatorReleaseCandidate) ([]creatorReleaseSubscriber, error) {
	where := []string{}
	args := []any{}
	if len(candidate.partyIDs) > 0 {
		where = append(where, `(sub.party_id IN (`+sqlPlaceholders(len(candidate.partyIDs))+`) AND (
			sub.subject_kind = 'circle' OR EXISTS (
				SELECT 1 FROM party_series AS series
				INNER JOIN party_series_work AS series_work ON series_work.series_id = series.id
				WHERE series.party_id = sub.party_id AND UPPER(series.title_id) = sub.series_title_id
					AND UPPER(series_work.primary_code) = ?
			)
		))`)
		for _, id := range candidate.partyIDs {
			args = append(args, id)
		}
		args = append(args, candidate.code)
	}
	if len(candidate.personIDs) > 0 {
		where = append(where, `sub.person_id IN (`+sqlPlaceholders(len(candidate.personIDs))+`)`)
		for _, id := range candidate.personIDs {
			args = append(args, id)
		}
	}
	if len(where) == 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT sub.id, sub.user_id, sub.subject_kind, COALESCE(sub.party_id, 0), sub.series_title_id,
			COALESCE(sub.person_id, 0), sub.activated_at, sub.watch_availability
		FROM creator_subscription AS sub
		INNER JOIN user_account AS account ON account.id = sub.user_id AND account.enabled = 1
		WHERE sub.activated_at IS NOT NULL AND (`+strings.Join(where, " OR ")+`)
		ORDER BY sub.user_id, sub.id
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	subscribers := []creatorReleaseSubscriber{}
	for rows.Next() {
		var item creatorReleaseSubscriber
		var activatedAt string
		if err := rows.Scan(&item.subscriptionID, &item.userID, &item.kind, &item.partyID, &item.seriesID, &item.personID, &activatedAt, &item.watchAvailability); err != nil {
			return nil, err
		}
		if parsed, err := parseSQLiteTime(activatedAt); err == nil {
			item.activatedAt = parsed
		}
		subscribers = append(subscribers, item)
	}
	return subscribers, rows.Err()
}

// creatorReleaseWork is what metadata knows about a new code after its
// family was synchronized.
type creatorReleaseWork struct {
	releaseDate          string
	canonical            bool
	canonicalReleaseDate string
	known                bool
}

func (s *Server) loadCreatorReleaseWork(ctx context.Context, code string) (creatorReleaseWork, error) {
	var work creatorReleaseWork
	var releaseDate, canonicalReleaseDate sql.NullString
	var canonical sql.NullBool
	err := s.db.QueryRowContext(ctx, `
		SELECT work.release_date, edition.is_canonical, (
			SELECT canonical_work.release_date
			FROM work_edition AS canonical_edition
			INNER JOIN work AS canonical_work ON canonical_work.id = canonical_edition.work_id
			WHERE canonical_edition.logical_work_id = edition.logical_work_id AND canonical_edition.is_canonical = 1
			LIMIT 1
		)
		FROM work
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		WHERE UPPER(work.primary_code) = ?
		LIMIT 1
	`, code).Scan(&releaseDate, &canonical, &canonicalReleaseDate)
	if errors.Is(err, sql.ErrNoRows) {
		return work, nil
	}
	if err != nil {
		return work, err
	}
	work.known = true
	work.releaseDate = normalizeGraphReleaseDate(releaseDate.String)
	work.canonical = !canonical.Valid || canonical.Bool
	work.canonicalReleaseDate = normalizeGraphReleaseDate(canonicalReleaseDate.String)
	return work, nil
}

// creatorReleaseEventType distinguishes a new language edition of a family
// released long before from a new work.
func creatorReleaseEventType(work creatorReleaseWork, now time.Time) string {
	if work.canonical || work.canonicalReleaseDate == "" {
		return "released"
	}
	if released, err := time.Parse("2006-01-02", work.canonicalReleaseDate); err == nil && released.Before(now.Add(-creatorSubscriptionReleaseGrace)) {
		return "edition"
	}
	return "released"
}

// creatorReleaseIsRecent applies the grace window to one subscriber. A work
// without a release date counts as new.
func creatorReleaseIsRecent(releaseDate string, activatedAt time.Time) bool {
	if releaseDate == "" || activatedAt.IsZero() {
		return true
	}
	released, err := time.Parse("2006-01-02", releaseDate)
	if err != nil {
		return true
	}
	return !released.Before(activatedAt.Add(-creatorSubscriptionReleaseGrace).Truncate(24 * time.Hour))
}

func (s *Server) processCreatorReleaseCandidates(ctx context.Context, runID int64, syncer dlsiteFamilyMetadataSyncer, execution *creatorSubscriptionExecution) error {
	candidates, err := s.creatorReleaseCandidates(ctx)
	if err != nil {
		return err
	}
	result := &execution.result
	now := time.Now().UTC()
	watchCodes := map[int64][]string{}
	synced := 0
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !workflowGraphWorkCodePattern.MatchString(candidate.code) {
			if err := s.markCreatorReleaseSeen(ctx, candidate); err != nil {
				return err
			}
			continue
		}
		subscribers, err := s.creatorReleaseSubscribers(ctx, candidate)
		if err != nil {
			return err
		}
		// A catalog date older than every subscriber's grace window settles the
		// code without a metadata request.
		if candidate.releaseDate != "" && !anyCreatorSubscriberRecent(subscribers, candidate.releaseDate) {
			if err := s.markCreatorReleaseSeen(ctx, candidate); err != nil {
				return err
			}
			continue
		}
		if synced >= creatorSubscriptionMaxNewWorks {
			result.Deferred++
			continue
		}
		synced++
		family, err := syncer.SyncFamily(ctx, candidate.code)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if err != nil && !family.RequestedUnavailable {
			slog.Warn("subscription new work metadata sync failed", "work_code", candidate.code, "error", err)
			execution.fail("metadata", candidate.code+": metadata could not be synced")
			continue
		}
		if family.RequestedUnavailable {
			if err := s.markCreatorReleaseSeen(ctx, candidate); err != nil {
				return err
			}
			continue
		}
		execution.metadata = append(execution.metadata, candidate.code)
		work, err := s.loadCreatorReleaseWork(ctx, candidate.code)
		if err != nil {
			return err
		}
		releaseDate := firstNonEmpty(work.releaseDate, candidate.releaseDate)
		eventType := creatorReleaseEventType(work, now)
		added, err := s.addCreatorReleaseFeedItems(ctx, runID, candidate, subscribers, eventType, releaseDate)
		if err != nil {
			return err
		}
		if len(added) > 0 {
			result.NewWorks++
		}
		for _, subscriber := range subscribers {
			if added[subscriber.subscriptionID] {
				execution.feed[subscriber.userID] = append(execution.feed[subscriber.userID], candidate.code)
				result.FeedItems++
				if subscriber.watchAvailability {
					watchCodes[subscriber.userID] = append(watchCodes[subscriber.userID], candidate.code)
				}
			}
		}
		if err := s.markCreatorReleaseSeen(ctx, candidate); err != nil {
			return err
		}
	}
	s.addSubscriptionReleasesToAvailabilityWatch(ctx, watchCodes, execution)
	return nil
}

func anyCreatorSubscriberRecent(subscribers []creatorReleaseSubscriber, releaseDate string) bool {
	for _, subscriber := range subscribers {
		if creatorReleaseIsRecent(releaseDate, subscriber.activatedAt) {
			return true
		}
	}
	return false
}

// addCreatorReleaseFeedItems adds one feed entry per subscriber whose grace
// window includes the release, and reports which subscriptions received one.
func (s *Server) addCreatorReleaseFeedItems(ctx context.Context, runID int64, candidate creatorReleaseCandidate, subscribers []creatorReleaseSubscriber, eventType string, releaseDate string) (map[int64]bool, error) {
	added := map[int64]bool{}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	for _, subscriber := range subscribers {
		if !creatorReleaseIsRecent(releaseDate, subscriber.activatedAt) {
			continue
		}
		var partyID, personID any
		if subscriber.partyID > 0 {
			partyID = subscriber.partyID
		}
		if subscriber.personID > 0 {
			personID = subscriber.personID
		}
		result, err := tx.ExecContext(ctx, `
			INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind, party_id, series_title_id, person_id, workflow_run_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, primary_code, event_type) DO NOTHING
		`, subscriber.userID, candidate.code, eventType, subscriber.kind, partyID, subscriber.seriesID, personID, nullableRunID(runID))
		if err != nil {
			return nil, err
		}
		if inserted, _ := result.RowsAffected(); inserted > 0 {
			added[subscriber.subscriptionID] = true
		}
	}
	return added, tx.Commit()
}

func (s *Server) markCreatorReleaseSeen(ctx context.Context, candidate creatorReleaseCandidate) error {
	for _, partyID := range candidate.partyIDs {
		if _, err := s.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO party_release_seen (party_id, primary_code) VALUES (?, ?)
		`, partyID, candidate.code); err != nil {
			return err
		}
	}
	for _, personID := range candidate.personIDs {
		if _, err := s.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO person_release_seen (person_id, primary_code) VALUES (?, ?)
		`, personID, candidate.code); err != nil {
			return err
		}
	}
	return nil
}

// addSubscriptionReleasesToAvailabilityWatch adds new works to the shared
// Availability Watch pool for subscriptions that ask for it, on behalf of a
// subscriber who may edit the pool.
func (s *Server) addSubscriptionReleasesToAvailabilityWatch(ctx context.Context, codesByUser map[int64][]string, execution *creatorSubscriptionExecution) {
	if len(codesByUser) == 0 {
		return
	}
	action, err := s.availabilityWatchConfiguredAction(ctx)
	if err != nil {
		execution.fail("watch", "Availability Watch configuration could not be read")
		return
	}
	userIDs := make([]int64, 0, len(codesByUser))
	for userID := range codesByUser {
		userIDs = append(userIDs, userID)
	}
	sort.Slice(userIDs, func(i, j int) bool { return userIDs[i] < userIDs[j] })
	for _, userID := range userIDs {
		owner, err := s.accountStore.LoadByID(ctx, userID)
		if err != nil || !userHasPermission(owner, "workflows:run") || validateAvailabilityWatchAction(owner, action) != nil {
			continue
		}
		codes, err := normalizeGraphWorkCodes(codesByUser[userID], 1000)
		if err != nil || len(codes) == 0 {
			continue
		}
		if err := s.persistAvailabilityWatchTargets(ctx, userID, codes, false); err != nil {
			execution.fail("watch", "new works could not be added to Availability Watch")
		}
	}
}

// dispatchSubscriptionAvailabilityWatch queues the Availability Watch check
// with the account that configured the watch.
func (s *Server) dispatchSubscriptionAvailabilityWatch(ctx context.Context, runID int64, execution *creatorSubscriptionExecution) {
	var ownerID sql.NullInt64
	var targets int
	err := s.db.QueryRowContext(ctx, `
		SELECT watch.configured_by_user_id, (
			SELECT COUNT(*) FROM availability_watch_target AS target WHERE target.watch_id = watch.id AND target.active = 1
		)
		FROM availability_watch AS watch WHERE watch.id = ?
	`, availabilityWatchID).Scan(&ownerID, &targets)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && targets == 0) {
		execution.watch = "empty"
		return
	}
	if err != nil {
		execution.watch = "failed"
		execution.fail("watch", "Availability Watch could not be read")
		return
	}
	action, err := s.availabilityWatchConfiguredAction(ctx)
	if err != nil {
		execution.watch = "failed"
		execution.fail("watch", "Availability Watch configuration could not be read")
		return
	}
	permissions := append([]string{"workflows:run"}, availabilityWatchPermissions(action)...)
	owner, err := s.loadSystemWorkflowTriggerOwner(ctx, ownerID.Int64, permissions)
	if err != nil {
		execution.watch = "failed"
		execution.fail("watch", "Availability Watch: "+err.Error())
		return
	}
	watchRun, err := s.enqueueAvailabilityWatch(ctx, owner.ID, workflowRunTrigger{Type: "follow_up", Reason: fmt.Sprintf("subscription_refresh:%d", runID)})
	if errors.Is(err, errAvailabilityWatchRunActive) {
		execution.watch = "active"
		return
	}
	if err != nil {
		execution.watch = "failed"
		execution.fail("watch", "Availability Watch could not be queued")
		return
	}
	execution.watch = "queued"
	execution.result.WatchRunID = watchRun.RunID
}

func (s *Server) finishCreatorSubscriptionJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, execution *creatorSubscriptionExecution) error {
	result := execution.result
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	catalogStatus, metadataStatus, watchStatus := "succeeded", "succeeded", "succeeded"
	catalogFailures, metadataFailures, watchFailures := execution.failures["catalogs"], execution.failures["metadata"], execution.failures["watch"]
	if len(catalogFailures) > 0 {
		catalogStatus = "partial"
	}
	if len(metadataFailures) > 0 {
		metadataStatus = "partial"
	}
	if len(watchFailures) > 0 {
		watchStatus = "partial"
	}
	if execution.watch == "skipped" || execution.watch == "empty" {
		watchStatus = "skipped"
	}
	updates := []struct {
		node, status string
		output       map[string]any
		failures     []string
	}{
		{"catalogs", catalogStatus, map[string]any{"circles": result.Circles, "voices": result.Voices, "refreshed": result.Refreshed, "catalogs": execution.catalogs}, catalogFailures},
		{"metadata", metadataStatus, map[string]any{"synced": len(execution.metadata), "deferred": result.Deferred, "codes": execution.metadata}, metadataFailures},
		{"feed", "succeeded", map[string]any{"new_works": result.NewWorks, "feed_items": result.FeedItems, "users": len(execution.feed)}, nil},
		{"watch", watchStatus, map[string]any{"state": execution.watch, "run_id": result.WatchRunID}, watchFailures},
	}
	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
		`, update.status, mustJSON(update.output), strings.Join(update.failures, "\n"), nodeIDs[update.node]); err != nil {
			return err
		}
	}
	errorMessage := strings.Join(result.Failures, "\n")
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, error_message = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, errorMessage, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, result.Status, mustJSON(result), job.RunID); err != nil {
		return err
	}
	if result.Status == "succeeded" {
		if err := updateWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
			return err
		}
	} else if err := updateWorkflowTriggerFailure(ctx, tx, job.RunID, "Subscription refresh completed with some failures"); err != nil {
		return err
	}
	for userID, codes := range execution.feed {
		if err := createSubscriptionReleaseNotification(ctx, tx, userID, job.RunID, codes); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// createSubscriptionReleaseNotification sends one notification per run to an
// account whose feed received new works; the feed itself lists them.
func createSubscriptionReleaseNotification(ctx context.Context, tx *sql.Tx, userID, runID int64, codes []string) error {
	if len(codes) == 0 {
		return nil
	}
	message := fmt.Sprintf("%d new works from your subscriptions.", len(codes))
	if len(codes) == 1 {
		message = codes[0] + " is new from your subscriptions."
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_notification (user_id, workflow_run_id, notification_type, status, work_code, message)
		VALUES (?, ?, 'subscription_release', 'succeeded', ?, ?)
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO UPDATE SET
			work_code = excluded.work_code,
			message = excluded.message
	`, userID, runID, codes[0], message)
	return err
}
