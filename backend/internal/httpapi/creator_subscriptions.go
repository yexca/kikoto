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

// Creator subscriptions record which circles, series, and voice actors an
// account wants new releases for. A subscription is personal; the catalogs it
// reads and the schedule that refreshes them are shared. A subscription takes
// effect once its catalog has a baseline: works already in the catalog then
// never count as new, so subscribing does not flood the feed.

const creatorSubscriptionWorkflowCode = "creator_subscription_refresh"

var errCreatorSubscriptionNotFound = errors.New("subscription not found")

type creatorSubscription struct {
	ID                int64   `json:"id"`
	Kind              string  `json:"kind"`
	CircleID          string  `json:"circleId,omitempty"`
	CircleName        string  `json:"circleName,omitempty"`
	SeriesID          string  `json:"seriesId,omitempty"`
	SeriesName        string  `json:"seriesName,omitempty"`
	PersonID          int64   `json:"personId,omitempty"`
	VoiceName         string  `json:"voiceName,omitempty"`
	WatchAvailability bool    `json:"watchAvailability"`
	Status            string  `json:"status"`
	ActivatedAt       *string `json:"activatedAt"`
	CreatedAt         string  `json:"createdAt"`
	CatalogSyncedAt   *string `json:"catalogSyncedAt"`
	partyID           int64
}

type creatorSubscriptionRequest struct {
	Kind              string `json:"kind"`
	CircleID          string `json:"circleId"`
	SeriesID          string `json:"seriesId"`
	PersonID          int64  `json:"personId"`
	WatchAvailability bool   `json:"watchAvailability"`
	// PullNow queues the catalog pull that sets the baseline instead of
	// waiting for the next scheduled refresh.
	PullNow bool `json:"pullNow"`
	// ReplaceSeries confirms that subscribing to a circle removes this
	// account's subscriptions to the circle's series.
	ReplaceSeries bool `json:"replaceSeries"`
}

type creatorSubscriptionSubject struct {
	Kind     string
	PartyID  int64
	CircleID string
	SeriesID string
	PersonID int64
}

type creatorSubscriptionCatalog struct {
	SyncState    string  `json:"syncState"`
	LastSyncedAt *string `json:"lastSyncedAt"`
}

type creatorSubscriptionLookup struct {
	Subscription *creatorSubscription `json:"subscription"`
	// CoveredBy is the circle subscription that already includes a series.
	CoveredBy *creatorSubscription `json:"coveredBy"`
	// Series lists this account's subscriptions to series of a circle.
	Series  []creatorSubscription      `json:"series"`
	Catalog creatorSubscriptionCatalog `json:"catalog"`
	// Available is false when a voice actor catalog has no compatible source.
	Available bool `json:"available"`
}

type creatorSubscriptionCreated struct {
	Subscription  creatorSubscription   `json:"subscription"`
	RemovedSeries []creatorSubscription `json:"removedSeries"`
	PullRun       *creatorRefreshRun    `json:"pullRun"`
}

func (s *Server) listCreatorSubscriptions(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeJSON(w, http.StatusOK, demoCreatorSubscriptionView())
		return
	}
	if err := s.activateCreatorSubscriptions(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	subscriptions, err := s.loadCreatorSubscriptions(r.Context(), "sub.user_id = ?", user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	schedule, err := s.loadCreatorSubscriptionSchedule(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"subscriptions": subscriptions, "schedule": schedule, "demo": false})
}

func (s *Server) lookupCreatorSubscription(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeJSON(w, http.StatusOK, creatorSubscriptionLookup{Series: []creatorSubscription{}, Catalog: creatorSubscriptionCatalog{SyncState: catalogSyncSynced}, Available: true})
		return
	}
	query := r.URL.Query()
	subject, err := s.resolveCreatorSubscriptionSubject(r.Context(), creatorSubscriptionRequest{
		Kind: query.Get("kind"), CircleID: query.Get("circleId"), SeriesID: query.Get("seriesId"), PersonID: int64(queryInt(r, "personId", 0)),
	})
	if !writeCreatorSubscriptionSubjectError(w, err) {
		return
	}
	if err := s.activateCreatorSubscriptions(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	lookup, err := s.creatorSubscriptionLookup(r.Context(), user.ID, subject)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lookup)
}

func (s *Server) createCreatorSubscription(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	var request creatorSubscriptionRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	subject, err := s.resolveCreatorSubscriptionSubject(r.Context(), request)
	if !writeCreatorSubscriptionSubjectError(w, err) {
		return
	}
	if subject.Kind == "voice" {
		sourceIDs, err := s.compatibleRemoteSourceIDs(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		if len(sourceIDs) == 0 {
			writeAPIError(w, http.StatusConflict, "voice_sources_unavailable", "Subscribing to a voice actor needs an enabled compatible remote source.", false)
			return
		}
	}
	if request.PullNow && !userHasPermission(user, "metadata:sync") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied", "permission": "metadata:sync"})
		return
	}
	created, conflict, err := s.subscribeCreator(r.Context(), user.ID, subject, request.WatchAvailability, request.ReplaceSeries)
	if err != nil {
		writeError(w, err)
		return
	}
	if conflict != nil {
		writeJSON(w, http.StatusConflict, conflict)
		return
	}
	if request.PullNow && created.Subscription.Status == "pending" {
		run, err := s.queueCreatorSubscriptionPull(r.Context(), user, subject)
		if err != nil {
			var refreshErr creatorRefreshError
			if !errors.As(err, &refreshErr) || refreshErr.status != http.StatusConflict {
				writeError(w, err)
				return
			}
			// An unrelated refresh of the same catalog is running; its
			// success also sets the baseline.
		} else {
			created.PullRun = &run
		}
	}
	writeJSON(w, http.StatusCreated, created)
}

func (s *Server) updateCreatorSubscription(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid subscription id"})
		return
	}
	var payload struct {
		WatchAvailability *bool `json:"watchAvailability"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.WatchAvailability == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "watchAvailability is required"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		UPDATE creator_subscription SET watch_availability = ? WHERE id = ? AND user_id = ?
	`, *payload.WatchAvailability, id, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": errCreatorSubscriptionNotFound.Error()})
		return
	}
	subscriptions, err := s.loadCreatorSubscriptions(r.Context(), "sub.id = ? AND sub.user_id = ?", id, user.ID)
	if err != nil || len(subscriptions) == 0 {
		writeError(w, firstError(err, errCreatorSubscriptionNotFound))
		return
	}
	writeJSON(w, http.StatusOK, subscriptions[0])
}

func (s *Server) deleteCreatorSubscription(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid subscription id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM creator_subscription WHERE id = ? AND user_id = ?", id, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	if changed, _ := result.RowsAffected(); changed == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": errCreatorSubscriptionNotFound.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func firstError(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

type creatorSubscriptionSubjectError struct {
	status  int
	code    string
	message string
}

func (e creatorSubscriptionSubjectError) Error() string { return e.message }

func writeCreatorSubscriptionSubjectError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return true
	}
	var subjectErr creatorSubscriptionSubjectError
	if errors.As(err, &subjectErr) {
		writeAPIError(w, subjectErr.status, subjectErr.code, subjectErr.message, false)
		return false
	}
	writeError(w, err)
	return false
}

// resolveCreatorSubscriptionSubject finds a stored circle, series, or voice
// actor. Subscribing never creates one; an unknown circle is added by its
// catalog sync first.
func (s *Server) resolveCreatorSubscriptionSubject(ctx context.Context, request creatorSubscriptionRequest) (creatorSubscriptionSubject, error) {
	subject := creatorSubscriptionSubject{Kind: strings.ToLower(strings.TrimSpace(request.Kind))}
	switch subject.Kind {
	case "circle", "series":
		subject.CircleID = normalizeMakerID(request.CircleID)
		if !dlsiteMakerIDPattern.MatchString(subject.CircleID) {
			return subject, creatorSubscriptionSubjectError{http.StatusBadRequest, "invalid_circle_id", "Choose a DLsite circle id such as RG12345."}
		}
		partyID, err := s.findCircle(ctx, subject.CircleID)
		if errors.Is(err, sql.ErrNoRows) {
			return subject, creatorSubscriptionSubjectError{http.StatusNotFound, "circle_not_in_database", "This circle is not in the database yet."}
		}
		if err != nil {
			return subject, err
		}
		visible, err := s.circlePartyVisible(ctx, partyID)
		if err != nil {
			return subject, err
		}
		if !visible {
			return subject, creatorSubscriptionSubjectError{http.StatusNotFound, "circle_not_in_database", "This circle is not in the database yet."}
		}
		subject.PartyID = partyID
		if subject.Kind == "series" {
			subject.SeriesID = normalizeSeriesID(request.SeriesID)
			if subject.SeriesID == "" {
				return subject, creatorSubscriptionSubjectError{http.StatusBadRequest, "invalid_series_id", "Choose a series of this circle."}
			}
			var found int
			if err := s.db.QueryRowContext(ctx, `
				SELECT COUNT(*) FROM party_series WHERE party_id = ? AND UPPER(title_id) = ?
			`, partyID, subject.SeriesID).Scan(&found); err != nil {
				return subject, err
			}
			if found == 0 {
				return subject, creatorSubscriptionSubjectError{http.StatusNotFound, "series_not_found", "This series is not in the circle catalog."}
			}
		}
	case "voice":
		if request.PersonID <= 0 {
			return subject, creatorSubscriptionSubjectError{http.StatusBadRequest, "invalid_person_id", "Choose a voice actor."}
		}
		if _, err := s.loadPersonName(ctx, request.PersonID); errors.Is(err, sql.ErrNoRows) {
			return subject, creatorSubscriptionSubjectError{http.StatusNotFound, "voice_not_found", "This voice actor is not in the database."}
		} else if err != nil {
			return subject, err
		}
		subject.PersonID = request.PersonID
	default:
		return subject, creatorSubscriptionSubjectError{http.StatusBadRequest, "invalid_kind", "Choose a circle, series, or voice actor."}
	}
	return subject, nil
}

// subscribeCreator adds a subscription and enforces that a circle
// subscription covers its series: a series of a subscribed circle is refused,
// and subscribing to a circle removes the account's series subscriptions only
// when the caller confirmed it.
func (s *Server) subscribeCreator(ctx context.Context, userID int64, subject creatorSubscriptionSubject, watchAvailability bool, replaceSeries bool) (creatorSubscriptionCreated, map[string]any, error) {
	created := creatorSubscriptionCreated{RemovedSeries: []creatorSubscription{}}
	existing, err := s.findCreatorSubscription(ctx, userID, subject)
	if err != nil {
		return created, nil, err
	}
	if existing != nil {
		created.Subscription = *existing
		return created, nil, nil
	}
	var series []creatorSubscription
	switch subject.Kind {
	case "series":
		circle, err := s.loadCreatorSubscriptions(ctx, "sub.user_id = ? AND sub.subject_kind = 'circle' AND sub.party_id = ?", userID, subject.PartyID)
		if err != nil {
			return created, nil, err
		}
		if len(circle) > 0 {
			return created, map[string]any{
				"code": "covered_by_circle", "error": "The circle subscription already includes this series.", "coveredBy": circle[0],
			}, nil
		}
	case "circle":
		series, err = s.loadCreatorSubscriptions(ctx, "sub.user_id = ? AND sub.subject_kind = 'series' AND sub.party_id = ?", userID, subject.PartyID)
		if err != nil {
			return created, nil, err
		}
		if len(series) > 0 && !replaceSeries {
			return created, map[string]any{
				"code": "series_will_be_removed", "error": "Subscribing to the circle replaces your series subscriptions.", "series": series,
			}, nil
		}
	}
	ready, err := s.creatorSubjectCatalogFresh(ctx, subject)
	if err != nil {
		return created, nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return created, nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if len(series) > 0 {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM creator_subscription WHERE user_id = ? AND subject_kind = 'series' AND party_id = ?
		`, userID, subject.PartyID); err != nil {
			return created, nil, err
		}
		created.RemovedSeries = series
	}
	if ready {
		if err := seedCreatorReleaseBaseline(ctx, tx, subject.PartyID, subject.PersonID); err != nil {
			return created, nil, err
		}
	}
	var partyID, personID any
	if subject.PartyID > 0 {
		partyID = subject.PartyID
	}
	if subject.PersonID > 0 {
		personID = subject.PersonID
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO creator_subscription (user_id, subject_kind, party_id, series_title_id, person_id, watch_availability, activated_at)
		VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? THEN CURRENT_TIMESTAMP END)
	`, userID, subject.Kind, partyID, subject.SeriesID, personID, watchAvailability, ready); err != nil {
		return created, nil, err
	}
	if err := tx.Commit(); err != nil {
		return created, nil, err
	}
	subscription, err := s.findCreatorSubscription(ctx, userID, subject)
	if err != nil {
		return created, nil, err
	}
	if subscription == nil {
		return created, nil, errCreatorSubscriptionNotFound
	}
	created.Subscription = *subscription
	return created, nil, nil
}

func (s *Server) findCreatorSubscription(ctx context.Context, userID int64, subject creatorSubscriptionSubject) (*creatorSubscription, error) {
	var subscriptions []creatorSubscription
	var err error
	if subject.Kind == "voice" {
		subscriptions, err = s.loadCreatorSubscriptions(ctx, "sub.user_id = ? AND sub.person_id = ?", userID, subject.PersonID)
	} else {
		subscriptions, err = s.loadCreatorSubscriptions(ctx, "sub.user_id = ? AND sub.party_id = ? AND sub.series_title_id = ?", userID, subject.PartyID, subject.SeriesID)
	}
	if err != nil || len(subscriptions) == 0 {
		return nil, err
	}
	return &subscriptions[0], nil
}

func (s *Server) creatorSubscriptionLookup(ctx context.Context, userID int64, subject creatorSubscriptionSubject) (creatorSubscriptionLookup, error) {
	lookup := creatorSubscriptionLookup{Series: []creatorSubscription{}, Available: true}
	subscription, err := s.findCreatorSubscription(ctx, userID, subject)
	if err != nil {
		return lookup, err
	}
	lookup.Subscription = subscription
	switch subject.Kind {
	case "series":
		circle, err := s.loadCreatorSubscriptions(ctx, "sub.user_id = ? AND sub.subject_kind = 'circle' AND sub.party_id = ?", userID, subject.PartyID)
		if err != nil {
			return lookup, err
		}
		if len(circle) > 0 {
			lookup.CoveredBy = &circle[0]
		}
	case "circle":
		series, err := s.loadCreatorSubscriptions(ctx, "sub.user_id = ? AND sub.subject_kind = 'series' AND sub.party_id = ?", userID, subject.PartyID)
		if err != nil {
			return lookup, err
		}
		lookup.Series = series
	case "voice":
		sourceIDs, err := s.compatibleRemoteSourceIDs(ctx)
		if err != nil {
			return lookup, err
		}
		lookup.Available = len(sourceIDs) > 0
	}
	lastSuccess, err := s.creatorSubjectLastSuccess(ctx, subject.PartyID, subject.PersonID)
	if err != nil {
		return lookup, err
	}
	lookup.Catalog.SyncState, _ = catalogFreshnessState(lastSuccess, "", s.catalogFreshnessDays(ctx), time.Now().UTC())
	if lastSuccess != "" {
		lookup.Catalog.LastSyncedAt = &lastSuccess
	}
	return lookup, nil
}

// creatorSubjectLastSuccess is the last successful catalog pull of a circle
// (DLsite) or voice actor (remote sources).
func (s *Server) creatorSubjectLastSuccess(ctx context.Context, partyID, personID int64) (string, error) {
	var value sql.NullString
	var err error
	if personID > 0 {
		err = s.db.QueryRowContext(ctx, "SELECT last_success_at FROM voice_catalog_refresh_state WHERE person_id = ?", personID).Scan(&value)
	} else {
		err = s.db.QueryRowContext(ctx, "SELECT last_success_at FROM party_catalog_refresh_state WHERE party_id = ? AND provider_code = 'dlsite'", partyID).Scan(&value)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return strings.TrimSpace(value.String), err
}

// creatorSubjectPullMode reads a catalog that was never pulled in full, as a
// detail page's First pull does, and refreshes a known one incrementally.
func (s *Server) creatorSubjectPullMode(ctx context.Context, partyID, personID int64) (string, error) {
	lastSuccess, err := s.creatorSubjectLastSuccess(ctx, partyID, personID)
	if err != nil {
		return "", err
	}
	if lastSuccess == "" {
		return "full", nil
	}
	return "incremental", nil
}

// creatorSubjectCatalogFresh reports whether the stored catalog is recent
// enough to serve as the baseline right away.
func (s *Server) creatorSubjectCatalogFresh(ctx context.Context, subject creatorSubscriptionSubject) (bool, error) {
	lastSuccess, err := s.creatorSubjectLastSuccess(ctx, subject.PartyID, subject.PersonID)
	if err != nil || lastSuccess == "" {
		return false, err
	}
	state, _ := catalogFreshnessState(lastSuccess, "", s.catalogFreshnessDays(ctx), time.Now().UTC())
	return state == catalogSyncSynced, nil
}

// seedCreatorReleaseBaseline marks every stored catalog code of a circle or
// voice actor as seen, unless another active subscription already keeps that
// seen set current.
func seedCreatorReleaseBaseline(ctx context.Context, tx *sql.Tx, partyID, personID int64) error {
	if personID > 0 {
		_, err := tx.ExecContext(ctx, `
			INSERT OR IGNORE INTO person_release_seen (person_id, primary_code)
			SELECT person_id, UPPER(primary_code) FROM voice_catalog_item
			WHERE person_id = ? AND NOT EXISTS (
				SELECT 1 FROM creator_subscription WHERE person_id = ? AND activated_at IS NOT NULL
			)
		`, personID, personID)
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO party_release_seen (party_id, primary_code)
		SELECT party_id, UPPER(primary_code) FROM party_catalog_item
		WHERE party_id = ? AND NOT EXISTS (
			SELECT 1 FROM creator_subscription WHERE party_id = ? AND activated_at IS NOT NULL
		)
	`, partyID, partyID)
	return err
}

// activateCreatorSubscriptions starts every pending subscription whose
// catalog was pulled successfully after it was created. The catalog at that
// moment becomes its baseline.
func (s *Server) activateCreatorSubscriptions(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT sub.id, COALESCE(sub.party_id, 0), COALESCE(sub.person_id, 0)
		FROM creator_subscription AS sub
		WHERE sub.activated_at IS NULL AND (
			EXISTS (
				SELECT 1 FROM party_catalog_refresh_state AS state
				WHERE state.party_id = sub.party_id AND state.provider_code = 'dlsite'
					AND state.last_success_at IS NOT NULL
					AND datetime(state.last_success_at) >= datetime(sub.created_at)
			)
			OR EXISTS (
				SELECT 1 FROM voice_catalog_refresh_state AS state
				WHERE state.person_id = sub.person_id
					AND state.last_success_at IS NOT NULL
					AND datetime(state.last_success_at) >= datetime(sub.created_at)
			)
		)
		ORDER BY sub.id
	`)
	if err != nil {
		return err
	}
	type pending struct{ id, partyID, personID int64 }
	items := []pending{}
	for rows.Next() {
		var item pending
		if err := rows.Scan(&item.id, &item.partyID, &item.personID); err != nil {
			_ = rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, item := range items {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if err := seedCreatorReleaseBaseline(ctx, tx, item.partyID, item.personID); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE creator_subscription SET activated_at = CURRENT_TIMESTAMP WHERE id = ? AND activated_at IS NULL
		`, item.id); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// queueCreatorSubscriptionPull queues a catalog-only sync whose success sets
// the baseline of a pending subscription.
func (s *Server) queueCreatorSubscriptionPull(ctx context.Context, actor currentUser, subject creatorSubscriptionSubject) (creatorRefreshRun, error) {
	mode, err := s.creatorSubjectPullMode(ctx, subject.PartyID, subject.PersonID)
	if err != nil {
		return creatorRefreshRun{}, err
	}
	if subject.Kind == "voice" {
		sourceIDs, err := s.compatibleRemoteSourceIDs(ctx)
		if err != nil {
			return creatorRefreshRun{}, err
		}
		inputs := presetWorkflowInputs{PersonID: subject.PersonID, CatalogRefresh: mode, SourceIDs: sourceIDs}
		return s.queueCreatorRefresh(ctx, actor, "voice_catalog_sync", inputs, func(ctx context.Context) (creatorRefreshRun, bool, error) {
			return s.latestVoiceCatalogSyncRun(ctx, subject.PersonID, true)
		})
	}
	inputs := presetWorkflowInputs{CircleID: subject.CircleID, CatalogRefresh: mode}
	return s.queueCreatorRefresh(ctx, actor, "circle_catalog_sync", inputs, func(ctx context.Context) (creatorRefreshRun, bool, error) {
		return s.latestCircleCatalogSyncRun(ctx, subject.CircleID, true)
	})
}

func (s *Server) loadCreatorSubscriptions(ctx context.Context, where string, args ...any) ([]creatorSubscription, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT sub.id, sub.subject_kind, COALESCE(sub.party_id, 0), sub.series_title_id, COALESCE(sub.person_id, 0),
			sub.watch_availability, sub.activated_at, sub.created_at,
			COALESCE(party.display_name, ''),
			COALESCE((
				SELECT external.external_id FROM party_external_id AS external
				INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id AND provider.code = 'dlsite'
				WHERE external.party_id = sub.party_id AND external.id_type = 'maker_id'
				ORDER BY external.is_primary DESC, external.id
				LIMIT 1
			), ''),
			COALESCE((
				SELECT series.name FROM party_series AS series
				WHERE series.party_id = sub.party_id AND UPPER(series.title_id) = sub.series_title_id
				ORDER BY series.last_seen_at DESC, series.id DESC
				LIMIT 1
			), ''),
			COALESCE(person.display_name, ''),
			CASE WHEN sub.person_id IS NOT NULL
				THEN (SELECT last_success_at FROM voice_catalog_refresh_state WHERE person_id = sub.person_id)
				ELSE (SELECT last_success_at FROM party_catalog_refresh_state WHERE party_id = sub.party_id AND provider_code = 'dlsite')
			END
		FROM creator_subscription AS sub
		LEFT JOIN party ON party.id = sub.party_id
		LEFT JOIN person ON person.id = sub.person_id
		WHERE `+where+`
		ORDER BY sub.created_at DESC, sub.id DESC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []creatorSubscription{}
	for rows.Next() {
		var item creatorSubscription
		var activatedAt, syncedAt sql.NullString
		if err := rows.Scan(&item.ID, &item.Kind, &item.partyID, &item.SeriesID, &item.PersonID, &item.WatchAvailability,
			&activatedAt, &item.CreatedAt, &item.CircleName, &item.CircleID, &item.SeriesName, &item.VoiceName, &syncedAt); err != nil {
			return nil, err
		}
		item.CircleID = normalizeMakerID(item.CircleID)
		item.Status = "pending"
		if activatedAt.Valid {
			item.Status = "active"
			item.ActivatedAt = &activatedAt.String
		}
		if syncedAt.Valid && strings.TrimSpace(syncedAt.String) != "" {
			item.CatalogSyncedAt = &syncedAt.String
		}
		if item.Kind == "series" && item.SeriesName == "" {
			item.SeriesName = item.SeriesID
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// The schedule is the fixed interval trigger of the subscription refresh
// workflow. Its options live in the trigger configuration.

type creatorSubscriptionScheduleConfig struct {
	AvailabilityWatch bool `json:"availabilityWatch"`
}

type creatorSubscriptionSchedule struct {
	Enabled           bool    `json:"enabled"`
	IntervalHours     int     `json:"intervalHours"`
	AvailabilityWatch bool    `json:"availabilityWatch"`
	NextRunAt         *string `json:"nextRunAt"`
	LastRunAt         *string `json:"lastRunAt"`
	LastSuccessAt     *string `json:"lastSuccessAt"`
	LastError         string  `json:"lastError"`
	LatestRun         *struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	} `json:"latestRun"`
	triggerID int64
}

const (
	creatorSubscriptionMinIntervalHours     = 1
	creatorSubscriptionMaxIntervalHours     = 168
	creatorSubscriptionDefaultIntervalHours = 24
)

func (s *Server) loadCreatorSubscriptionSchedule(ctx context.Context) (creatorSubscriptionSchedule, error) {
	schedule := creatorSubscriptionSchedule{IntervalHours: creatorSubscriptionDefaultIntervalHours}
	var scheduleJSON, configJSON string
	var nextRunAt, lastRunAt, lastSuccessAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT trigger.id, trigger.enabled, trigger.schedule_json, trigger.config_json,
			trigger.next_run_at, trigger.last_run_at, trigger.last_success_at, trigger.last_error_message
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = ? AND trigger.trigger_type = 'schedule'
		ORDER BY trigger.id
		LIMIT 1
	`, creatorSubscriptionWorkflowCode).Scan(&schedule.triggerID, &schedule.Enabled, &scheduleJSON, &configJSON,
		&nextRunAt, &lastRunAt, &lastSuccessAt, &schedule.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return schedule, nil
	}
	if err != nil {
		return schedule, err
	}
	var interval workflowIntervalSchedule
	if json.Unmarshal([]byte(scheduleJSON), &interval) == nil && interval.IntervalMinutes > 0 {
		schedule.IntervalHours = max(creatorSubscriptionMinIntervalHours, (interval.IntervalMinutes+59)/60)
	}
	var config creatorSubscriptionScheduleConfig
	if json.Unmarshal([]byte(configJSON), &config) == nil {
		schedule.AvailabilityWatch = config.AvailabilityWatch
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
	`, creatorSubscriptionWorkflowCode).Scan(&latest.ID, &latest.Status)
	if err == nil {
		schedule.LatestRun = &latest
	} else if !errors.Is(err, sql.ErrNoRows) {
		return schedule, err
	}
	return schedule, nil
}

// ensureCreatorSubscriptionSchedule keeps the fixed schedule present and
// plans its first run after startup, since the migration cannot know when the
// server starts.
func (s *Server) ensureCreatorSubscriptionSchedule(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
		SELECT definition.id, 'schedule', 'Subscription refresh', 1, ?, ?
		FROM workflow_definition AS definition
		WHERE definition.code = ? AND NOT EXISTS (
			SELECT 1 FROM workflow_trigger AS trigger WHERE trigger.workflow_definition_id = definition.id
		)
	`, mustJSON(workflowIntervalSchedule{IntervalMinutes: creatorSubscriptionDefaultIntervalHours * 60}),
		mustJSON(creatorSubscriptionScheduleConfig{AvailabilityWatch: true}), creatorSubscriptionWorkflowCode); err != nil {
		return err
	}
	schedule, err := s.loadCreatorSubscriptionSchedule(ctx)
	if err != nil || schedule.triggerID == 0 || !schedule.Enabled {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE workflow_trigger SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at IS NULL
	`, formatWorkflowTimestamp(time.Now().UTC().Add(time.Duration(schedule.IntervalHours)*time.Hour)), schedule.triggerID)
	return err
}

func (s *Server) updateCreatorSubscriptionSchedule(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	var payload struct {
		Enabled           *bool `json:"enabled"`
		IntervalHours     *int  `json:"intervalHours"`
		AvailabilityWatch *bool `json:"availabilityWatch"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	current, err := s.loadCreatorSubscriptionSchedule(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if current.triggerID == 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "the subscription schedule is unavailable"})
		return
	}
	enabled, interval, watch := current.Enabled, current.IntervalHours, current.AvailabilityWatch
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	if payload.IntervalHours != nil {
		interval = *payload.IntervalHours
	}
	if payload.AvailabilityWatch != nil {
		watch = *payload.AvailabilityWatch
	}
	if interval < creatorSubscriptionMinIntervalHours || interval > creatorSubscriptionMaxIntervalHours {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("intervalHours must be between %d and %d", creatorSubscriptionMinIntervalHours, creatorSubscriptionMaxIntervalHours)})
		return
	}
	var nextRunAt any
	if enabled {
		nextRunAt = formatWorkflowTimestamp(time.Now().UTC().Add(time.Duration(interval) * time.Hour))
	}
	if _, err := s.db.ExecContext(r.Context(), `
		UPDATE workflow_trigger
		SET enabled = ?, schedule_json = ?, config_json = ?, next_run_at = ?, last_error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, enabled, mustJSON(workflowIntervalSchedule{IntervalMinutes: interval * 60}), mustJSON(creatorSubscriptionScheduleConfig{AvailabilityWatch: watch}), nextRunAt, current.triggerID); err != nil {
		writeError(w, err)
		return
	}
	schedule, err := s.loadCreatorSubscriptionSchedule(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, schedule)
}

func (s *Server) runCreatorSubscriptionRefresh(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	schedule, err := s.loadCreatorSubscriptionSchedule(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	result, err := s.enqueueCreatorSubscriptionRefresh(r.Context(), workflowRunTrigger{Type: "manual", Reason: "manual_run"}, actor.ID, schedule.AvailabilityWatch)
	if errors.Is(err, errCreatorSubscriptionRunActive) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) executeCreatorSubscriptionSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	var config creatorSubscriptionScheduleConfig
	if strings.TrimSpace(trigger.ConfigJSON) != "" {
		if err := json.Unmarshal([]byte(trigger.ConfigJSON), &config); err != nil {
			return "", nil, fmt.Errorf("subscription refresh trigger config is invalid")
		}
	}
	_, err := s.enqueueCreatorSubscriptionRefresh(ctx, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID}, 0, config.AvailabilityWatch)
	if errors.Is(err, errCreatorSubscriptionRunActive) {
		return "succeeded", nil, nil
	}
	return "succeeded", nil, err
}
