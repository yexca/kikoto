package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

var dlsiteMakerIDPattern = regexp.MustCompile(`(?i)^[RBV]G[0-9]{5,8}$`)

type circleSummary struct {
	ID              int64              `json:"id"`
	ExternalID      string             `json:"externalId"`
	DisplayName     string             `json:"displayName"`
	Aliases         []string           `json:"aliases"`
	Rating          *int               `json:"rating"`
	Note            string             `json:"note"`
	Favorite        bool               `json:"favorite"`
	LocalWorks      int                `json:"localWorks"`
	PlayableWorks   int                `json:"playableWorks"`
	RemoteWorks     int                `json:"remoteWorks"`
	MissingWorks    int                `json:"missingWorks"`
	CatalogWorks    int                `json:"catalogWorks"`
	LastSyncedAt    *string            `json:"lastSyncedAt"`
	SyncState       string             `json:"syncState"`
	SourceSummaries []circleSourceStat `json:"sourceSummaries"`
}

type circleSourceStat struct {
	Key         string `json:"key"`
	SourceID    *int64 `json:"sourceId"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
	Count       int    `json:"count"`
}

type circleDetail struct {
	circleSummary
	Works []circleCatalogWork `json:"works"`
}

type circleCatalogWork struct {
	WorkID        *int64             `json:"workId"`
	PrimaryCode   string             `json:"primaryCode"`
	Title         string             `json:"title"`
	ReleaseDate   *string            `json:"releaseDate"`
	CoverURL      string             `json:"coverUrl"`
	DLsiteURL     string             `json:"dlsiteUrl"`
	CatalogStatus string             `json:"catalogStatus"`
	ListeningMark string             `json:"listeningMark"`
	Local         bool               `json:"local"`
	Remote        bool               `json:"remote"`
	SourceTags    []circleSourceStat `json:"sourceTags"`
}

type circleRefreshRequest struct {
	Mode        string `json:"mode"`
	ProductMode string `json:"productMode"`
}

func (s *Server) listCircles(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if err := s.ensureCircleSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	if err := s.syncPartiesFromDLsiteSnapshots(r.Context()); err != nil {
		writeError(w, err)
		return
	}

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			party.id,
			external.external_id,
			party.display_name,
			state.rating,
			COALESCE(state.note, ''),
			COALESCE(state.favorite, 0),
			(
				SELECT MAX(snapshot.fetched_at)
				FROM party_metadata_snapshot AS snapshot
				WHERE snapshot.party_id = party.id
			) AS last_synced_at
		FROM party
		INNER JOIN party_external_id AS external ON external.party_id = party.id
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		LEFT JOIN user_party_state AS state ON state.party_id = party.id AND state.user_id = ?
		WHERE party.party_type IN ('circle', 'brand', 'maker')
			AND provider.code = 'dlsite'
			AND external.id_type = 'maker_id'
		ORDER BY party.display_name ASC
		LIMIT 100
	`, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	items := []circleSummary{}
	for rows.Next() {
		var item circleSummary
		var rating sql.NullInt64
		var favorite int
		var lastSynced sql.NullString
		if err := rows.Scan(&item.ID, &item.ExternalID, &item.DisplayName, &rating, &item.Note, &favorite, &lastSynced); err != nil {
			writeError(w, err)
			return
		}
		item.Rating = nullableIntPointer(rating)
		item.Favorite = favorite != 0
		item.LastSyncedAt = nullableString(lastSynced)
		item.Aliases = []string{}
		if err := s.fillCircleStats(r.Context(), user.ID, &item); err != nil {
			writeError(w, err)
			return
		}
		items = append(items, item)
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) getCircle(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	if err := s.ensureCircleSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	if err := s.syncPartiesFromDLsiteSnapshots(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	partyID, err := s.ensurePlaceholderCircle(r.Context(), externalID)
	if err != nil {
		writeError(w, err)
		return
	}

	summary, err := s.loadCircleSummary(r.Context(), user.ID, partyID)
	if err != nil {
		writeError(w, err)
		return
	}
	works, err := s.loadCircleWorks(r.Context(), user.ID, partyID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, circleDetail{circleSummary: summary, Works: works})
}

func (s *Server) updateCircleUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	var payload struct {
		Rating   *int    `json:"rating"`
		Note     *string `json:"note"`
		Favorite *bool   `json:"favorite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if payload.Rating != nil && (*payload.Rating < 0 || *payload.Rating > 5) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "rating must be between 0 and 5"})
		return
	}
	if err := s.ensureCircleSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	partyID, err := s.ensurePlaceholderCircle(r.Context(), externalID)
	if err != nil {
		writeError(w, err)
		return
	}
	ratingValue := any(nil)
	if payload.Rating != nil && *payload.Rating > 0 {
		ratingValue = *payload.Rating
	}
	note := ""
	if payload.Note != nil {
		note = strings.TrimSpace(*payload.Note)
	}
	favorite := 0
	if payload.Favorite != nil && *payload.Favorite {
		favorite = 1
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_party_state (user_id, party_id, rating, note, favorite, updated_at)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, party_id) DO UPDATE SET
			rating = excluded.rating,
			note = excluded.note,
			favorite = excluded.favorite,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, partyID, ratingValue, note, favorite); err != nil {
		writeError(w, err)
		return
	}
	summary, err := s.loadCircleSummary(r.Context(), user.ID, partyID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) refreshCircle(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	if err := s.ensureCircleSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	partyID, err := s.ensurePlaceholderCircle(r.Context(), externalID)
	if err != nil {
		writeError(w, err)
		return
	}
	var payload circleRefreshRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&payload)
	}
	payload = normalizeCircleRefreshRequest(payload)
	result, err := s.runCircleRefresh(r.Context(), partyID, externalID, payload)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"runId":         result.RunID,
		"externalId":    externalID,
		"status":        result.Status,
		"catalogWorks":  result.CatalogWorks,
		"pagesFetched":  result.PagesFetched,
		"productSynced": result.ProductSynced,
		"mode":          result.Mode,
		"productMode":   result.ProductMode,
	})
}

func (s *Server) ensureCircleSchema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS party (
			id INTEGER PRIMARY KEY,
			party_type TEXT NOT NULL DEFAULT 'circle',
			display_name TEXT NOT NULL,
			sort_name TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS party_external_id (
			id INTEGER PRIMARY KEY,
			party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
			provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
			id_type TEXT NOT NULL,
			external_id TEXT NOT NULL,
			url TEXT NOT NULL DEFAULT '',
			is_primary INTEGER NOT NULL DEFAULT 0,
			UNIQUE(provider_id, id_type, external_id)
		)`,
		`CREATE TABLE IF NOT EXISTS party_metadata_snapshot (
			id INTEGER PRIMARY KEY,
			party_id INTEGER REFERENCES party(id) ON DELETE SET NULL,
			provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
			external_id TEXT NOT NULL,
			snapshot_json TEXT NOT NULL,
			fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS party_catalog_item (
			id INTEGER PRIMARY KEY,
			party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
			provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
			primary_code TEXT NOT NULL,
			title TEXT NOT NULL DEFAULT '',
			release_date TEXT,
			url TEXT NOT NULL DEFAULT '',
			catalog_status TEXT NOT NULL DEFAULT 'imported',
			raw_json TEXT NOT NULL DEFAULT '{}',
			last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(party_id, provider_id, primary_code)
		)`,
		`CREATE TABLE IF NOT EXISTS user_party_state (
			user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
			party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
			rating INTEGER,
			note TEXT NOT NULL DEFAULT '',
			favorite INTEGER NOT NULL DEFAULT 0,
			last_viewed_at TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(user_id, party_id)
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) syncPartiesFromDLsiteSnapshots(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id, work.primary_code, work.title, work.release_date, snapshot.snapshot_json
		FROM work
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.work_id = work.id
		INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
		WHERE provider.code = 'dlsite'
		ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
	`)
	if err != nil {
		return err
	}
	defer rows.Close()
	seenWork := map[int64]bool{}
	for rows.Next() {
		var workID int64
		var code, title string
		var release sql.NullString
		var raw string
		if err := rows.Scan(&workID, &code, &title, &release, &raw); err != nil {
			return err
		}
		if seenWork[workID] {
			continue
		}
		seenWork[workID] = true
		party := parsePartyFromDLsiteSnapshot(raw)
		if !dlsiteMakerIDPattern.MatchString(party.ExternalID) || party.DisplayName == "" {
			continue
		}
		partyID, err := s.upsertDLsiteParty(ctx, party.ExternalID, party.DisplayName, raw)
		if err != nil {
			return err
		}
		if err := s.upsertPartyCatalogItem(ctx, partyID, code, title, nullableStringValue(release), dlsiteURL(code), "imported", raw); err != nil {
			return err
		}
	}
	return rows.Err()
}

type parsedParty struct {
	ExternalID  string
	DisplayName string
}

func parsePartyFromDLsiteSnapshot(raw string) parsedParty {
	if strings.TrimSpace(raw) == "" {
		return parsedParty{}
	}
	rawBytes := []byte(raw)
	var combined struct {
		Product json.RawMessage `json:"product"`
	}
	if err := json.Unmarshal(rawBytes, &combined); err == nil && len(combined.Product) > 0 {
		rawBytes = combined.Product
	}
	var payload struct {
		MakerID   string `json:"maker_id"`
		MakerName string `json:"maker_name"`
		CircleID  string `json:"circle_id"`
		BrandID   string `json:"brand_id"`
		LabelID   string `json:"label_id"`
		LabelName string `json:"label_name"`
	}
	if err := json.Unmarshal(rawBytes, &payload); err != nil {
		return parsedParty{}
	}
	externalID := firstNonEmpty(payload.CircleID, payload.MakerID, payload.BrandID, payload.LabelID)
	displayName := firstNonEmpty(payload.MakerName, payload.LabelName, externalID)
	return parsedParty{ExternalID: normalizeMakerID(externalID), DisplayName: strings.TrimSpace(displayName)}
}

func (s *Server) upsertDLsiteParty(ctx context.Context, externalID string, displayName string, raw string) (int64, error) {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return 0, err
	}
	var existingPartyID int64
	err = s.db.QueryRowContext(ctx, `
		SELECT party_id
		FROM party_external_id
		WHERE provider_id = ? AND id_type = 'maker_id' AND external_id = ?
	`, providerID, externalID).Scan(&existingPartyID)
	if err == nil {
		if _, err := s.db.ExecContext(ctx, `
			UPDATE party
			SET display_name = ?, sort_name = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, displayName, strings.ToLower(displayName), existingPartyID); err != nil {
			return 0, err
		}
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO party_metadata_snapshot (party_id, provider_id, external_id, snapshot_json)
			SELECT ?, ?, ?, ?
			WHERE NOT EXISTS (
				SELECT 1
				FROM party_metadata_snapshot
				WHERE party_id = ?
					AND provider_id = ?
					AND external_id = ?
					AND snapshot_json = ?
			)
		`, existingPartyID, providerID, externalID, raw, existingPartyID, providerID, externalID, raw); err != nil {
			return 0, err
		}
		return existingPartyID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO party (party_type, display_name, sort_name)
		VALUES ('circle', ?, ?)
	`, displayName, strings.ToLower(displayName)); err != nil {
		return 0, err
	}
	partyID, err := lastInsertID(tx)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, url, is_primary)
		VALUES (?, ?, 'maker_id', ?, ?, 1)
		ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
			party_id = excluded.party_id,
			url = excluded.url,
			is_primary = excluded.is_primary
	`, partyID, providerID, externalID, dlsiteMakerURL(externalID)); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO party_metadata_snapshot (party_id, provider_id, external_id, snapshot_json)
		SELECT ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1
			FROM party_metadata_snapshot
			WHERE party_id = ?
				AND provider_id = ?
				AND external_id = ?
				AND snapshot_json = ?
		)
	`, partyID, providerID, externalID, raw, partyID, providerID, externalID, raw); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return partyID, nil
}

func (s *Server) upsertPartyCatalogItem(ctx context.Context, partyID int64, code string, title string, releaseDate *string, url string, status string, raw string) error {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date, url, catalog_status, raw_json, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(party_id, provider_id, primary_code) DO UPDATE SET
			title = excluded.title,
			release_date = excluded.release_date,
			url = excluded.url,
			catalog_status = excluded.catalog_status,
			raw_json = excluded.raw_json,
			last_seen_at = CURRENT_TIMESTAMP
	`, partyID, providerID, strings.ToUpper(strings.TrimSpace(code)), title, releaseDate, url, status, raw)
	return err
}

func (s *Server) ensurePlaceholderCircle(ctx context.Context, externalID string) (int64, error) {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return 0, err
	}
	var partyID int64
	err = s.db.QueryRowContext(ctx, `
		SELECT party_id
		FROM party_external_id
		WHERE provider_id = ? AND id_type = 'maker_id' AND external_id = ?
	`, providerID, externalID).Scan(&partyID)
	if err == nil {
		return partyID, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	return s.upsertDLsiteParty(ctx, externalID, "Unfetched circle "+externalID, "{}")
}

func (s *Server) loadCircleSummary(ctx context.Context, userID int64, partyID int64) (circleSummary, error) {
	var item circleSummary
	var rating sql.NullInt64
	var favorite int
	var lastSynced sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			party.id,
			external.external_id,
			party.display_name,
			state.rating,
			COALESCE(state.note, ''),
			COALESCE(state.favorite, 0),
			(
				SELECT MAX(snapshot.fetched_at)
				FROM party_metadata_snapshot AS snapshot
				WHERE snapshot.party_id = party.id
			) AS last_synced_at
		FROM party
		INNER JOIN party_external_id AS external ON external.party_id = party.id
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		LEFT JOIN user_party_state AS state ON state.party_id = party.id AND state.user_id = ?
		WHERE party.id = ? AND provider.code = 'dlsite' AND external.id_type = 'maker_id'
	`, userID, partyID).Scan(&item.ID, &item.ExternalID, &item.DisplayName, &rating, &item.Note, &favorite, &lastSynced); err != nil {
		return circleSummary{}, err
	}
	item.Rating = nullableIntPointer(rating)
	item.Favorite = favorite != 0
	item.LastSyncedAt = nullableString(lastSynced)
	item.Aliases = []string{}
	if err := s.fillCircleStats(ctx, userID, &item); err != nil {
		return circleSummary{}, err
	}
	return item, nil
}

func (s *Server) fillCircleStats(ctx context.Context, userID int64, item *circleSummary) error {
	var catalogWorks int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM party_catalog_item WHERE party_id = ?", item.ID).Scan(&catalogWorks); err != nil {
		return err
	}
	item.CatalogWorks = catalogWorks
	stats, err := s.circleSourceStats(ctx, item.ID)
	if err != nil {
		return err
	}
	item.SourceSummaries = stats
	for _, stat := range stats {
		switch stat.Key {
		case "local":
			item.LocalWorks = stat.Count
			item.PlayableWorks = stat.Count
		case "remote":
			item.RemoteWorks += stat.Count
		}
	}
	item.MissingWorks = catalogWorks - item.LocalWorks - item.RemoteWorks
	if item.MissingWorks < 0 {
		item.MissingWorks = 0
	}
	item.SyncState = "fresh"
	if item.LastSyncedAt == nil {
		item.SyncState = "pending"
	} else if catalogWorks == 0 {
		item.SyncState = "stale"
	}
	return nil
}

func (s *Server) circleSourceStats(ctx context.Context, partyID int64) ([]circleSourceStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, location.location_type, COUNT(DISTINCT work.id)
		FROM party_catalog_item AS catalog
		INNER JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE catalog.party_id = ?
			AND location.availability = 'available'
		GROUP BY source.id, source.display_name, location.location_type
		ORDER BY source.display_name ASC
	`, partyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	combined := map[string]circleSourceStat{}
	for rows.Next() {
		var sourceID int64
		var sourceName, locationType string
		var count int
		if err := rows.Scan(&sourceID, &sourceName, &locationType, &count); err != nil {
			return nil, err
		}
		key := "remote"
		display := sourceName
		if locationType == "local" {
			key = "local"
			display = "Local"
		}
		statKey := key
		if key == "remote" {
			statKey = fmt.Sprintf("source:%d", sourceID)
		}
		stat := combined[statKey]
		if stat.Key == "" {
			stat = circleSourceStat{Key: statKey, DisplayName: display, Status: "available"}
			if key == "remote" {
				stat.SourceID = &sourceID
			} else {
				stat.SourceID = nil
			}
		}
		stat.Count += count
		combined[statKey] = stat
	}
	result := []circleSourceStat{}
	remoteTotal := 0
	for _, stat := range combined {
		if stat.SourceID != nil {
			remoteTotal += stat.Count
		}
		result = append(result, stat)
	}
	if remoteTotal > 0 {
		result = append([]circleSourceStat{{Key: "remote", DisplayName: "Remote", Status: "available", Count: remoteTotal}}, result...)
	}
	return result, rows.Err()
}

func (s *Server) loadCircleWorks(ctx context.Context, userID int64, partyID int64) ([]circleCatalogWork, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			catalog.primary_code,
			catalog.title,
			catalog.release_date,
			catalog.url,
			catalog.catalog_status,
			work.id,
			COALESCE(user_work_state.listening_status, 'none')
		FROM party_catalog_item AS catalog
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		WHERE catalog.party_id = ?
		ORDER BY catalog.release_date DESC, catalog.primary_code DESC
		LIMIT 100
	`, userID, partyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	works := []circleCatalogWork{}
	for rows.Next() {
		var item circleCatalogWork
		var release sql.NullString
		var workID sql.NullInt64
		if err := rows.Scan(&item.PrimaryCode, &item.Title, &release, &item.DLsiteURL, &item.CatalogStatus, &workID, &item.ListeningMark); err != nil {
			return nil, err
		}
		item.ReleaseDate = nullableString(release)
		item.WorkID = nullableInt64(workID)
		item.CoverURL = s.coverURL(item.PrimaryCode)
		tags, err := s.workSourceTags(ctx, item.PrimaryCode)
		if err != nil {
			return nil, err
		}
		item.SourceTags = tags
		for _, tag := range tags {
			if tag.Key == "local" {
				item.Local = true
			}
			if tag.Key == "remote" || strings.HasPrefix(tag.Key, "source:") {
				item.Remote = true
			}
		}
		works = append(works, item)
	}
	return works, rows.Err()
}

func (s *Server) workSourceTags(ctx context.Context, code string) ([]circleSourceStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, location.location_type, COUNT(*)
		FROM work
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE UPPER(work.primary_code) = UPPER(?)
			AND location.availability = 'available'
		GROUP BY source.id, source.display_name, location.location_type
	`, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []circleSourceStat{}
	hasRemote := false
	for rows.Next() {
		var sourceID int64
		var sourceName, locationType string
		var count int
		if err := rows.Scan(&sourceID, &sourceName, &locationType, &count); err != nil {
			return nil, err
		}
		if locationType == "local" {
			tags = append(tags, circleSourceStat{Key: "local", DisplayName: "Local", Status: "available", Count: count})
			continue
		}
		hasRemote = true
		tags = append(tags, circleSourceStat{Key: fmt.Sprintf("source:%d", sourceID), SourceID: &sourceID, DisplayName: sourceName, Status: "available", Count: count})
	}
	if hasRemote {
		tags = append([]circleSourceStat{{Key: "remote", DisplayName: "Remote", Status: "available", Count: 1}}, tags...)
	}
	return tags, rows.Err()
}

type circleRefreshResult struct {
	RunID         int64
	JobID         int64
	Status        string
	CatalogWorks  int
	PagesFetched  int
	ProductSynced int
	Mode          string
	ProductMode   string
	Error         string
}

func (s *Server) runCircleRefresh(ctx context.Context, partyID int64, externalID string, request circleRefreshRequest) (circleRefreshResult, error) {
	client := dlsite.NewClient(nil)
	knownCodes, err := s.knownCircleCatalogCodes(ctx, partyID)
	if err != nil {
		return circleRefreshResult{}, err
	}
	profile, fetchErr := client.FetchMakerCatalog(ctx, externalID, dlsite.MakerCatalogOptions{
		Mode:           request.Mode,
		MaxPages:       circleRefreshMaxPages(request.Mode),
		KnownWorkCodes: knownCodes,
		Delay:          s.circleRefreshDelay(ctx),
	})
	result := circleRefreshResult{Status: "succeeded", Mode: request.Mode, ProductMode: request.ProductMode}
	if fetchErr != nil {
		result.Status = "failed"
		result.Error = fetchErr.Error()
	} else {
		if err := s.applyMakerProfile(ctx, partyID, profile, request.Mode == "full"); err != nil {
			result.Status = "failed"
			result.Error = err.Error()
		} else {
			result.CatalogWorks = len(profile.WorkCodes)
			result.PagesFetched = profile.PagesFetched
			productSynced, err := s.syncCircleProductJSON(ctx, partyID, profile.WorkCodes, request.ProductMode, client)
			if err != nil {
				result.Status = "failed"
				result.Error = err.Error()
			} else {
				result.ProductSynced = productSynced
			}
		}
	}
	runID, jobID, err := s.recordCircleRefreshWorkflow(ctx, partyID, externalID, profile, result)
	if err != nil {
		return circleRefreshResult{}, err
	}
	result.RunID = runID
	result.JobID = jobID
	if result.Status == "failed" {
		return result, fmt.Errorf("%s", result.Error)
	}
	return result, nil
}

func (s *Server) applyMakerProfile(ctx context.Context, partyID int64, profile dlsite.MakerProfile, pruneMissing bool) error {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	name := strings.TrimSpace(profile.MakerName)
	if name == "" {
		name = "Unfetched circle " + profile.MakerID
	}
	raw, err := json.Marshal(map[string]any{
		"maker_id":      profile.MakerID,
		"maker_name":    name,
		"site_id":       profile.SiteID,
		"url":           profile.URL,
		"work_codes":    profile.WorkCodes,
		"pages_fetched": profile.PagesFetched,
		"reached_end":   profile.ReachedEnd,
	})
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE party
		SET display_name = ?, sort_name = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, name, strings.ToLower(name), partyID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO party_metadata_snapshot (party_id, provider_id, external_id, snapshot_json)
		VALUES (?, ?, ?, ?)
	`, partyID, providerID, profile.MakerID, string(raw)); err != nil {
		return err
	}
	if pruneMissing {
		if len(profile.WorkCodes) == 0 {
			if _, err := tx.ExecContext(ctx, "DELETE FROM party_catalog_item WHERE party_id = ? AND provider_id = ?", partyID, providerID); err != nil {
				return err
			}
		} else {
			placeholders := make([]string, 0, len(profile.WorkCodes))
			args := []any{partyID, providerID}
			for _, code := range profile.WorkCodes {
				placeholders = append(placeholders, "?")
				args = append(args, strings.ToUpper(strings.TrimSpace(code)))
			}
			query := fmt.Sprintf("DELETE FROM party_catalog_item WHERE party_id = ? AND provider_id = ? AND UPPER(primary_code) NOT IN (%s)", strings.Join(placeholders, ","))
			if _, err := tx.ExecContext(ctx, query, args...); err != nil {
				return err
			}
		}
	}
	for _, code := range profile.WorkCodes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, url, catalog_status, raw_json, last_seen_at)
			VALUES (?, ?, ?, ?, ?, 'catalog', ?, CURRENT_TIMESTAMP)
			ON CONFLICT(party_id, provider_id, primary_code) DO UPDATE SET
				url = excluded.url,
				catalog_status = CASE
					WHEN party_catalog_item.catalog_status = 'imported' THEN party_catalog_item.catalog_status
					ELSE excluded.catalog_status
				END,
				raw_json = excluded.raw_json,
				last_seen_at = CURRENT_TIMESTAMP
		`, partyID, providerID, code, code, dlsiteURL(code), string(raw)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) syncCircleProductJSON(ctx context.Context, partyID int64, workCodes []string, productMode string, client *dlsite.Client) (int, error) {
	if len(workCodes) == 0 {
		return 0, nil
	}
	candidates := workCodes
	if productMode != "all" {
		available, err := s.availableCircleCatalogCodes(ctx, partyID, workCodes)
		if err != nil {
			return 0, err
		}
		filtered := []string{}
		for _, code := range workCodes {
			if available[strings.ToUpper(strings.TrimSpace(code))] {
				filtered = append(filtered, code)
			}
		}
		candidates = filtered
	}
	synced := 0
	for _, code := range candidates {
		if err := s.waitRemoteDownloadDelay(ctx); err != nil {
			return synced, err
		}
		product, err := client.FetchProduct(ctx, code)
		if err != nil {
			continue
		}
		raw := string(product.Raw)
		title := firstNonEmpty(product.WorkName, product.ProductName, product.WorkNo)
		release := nullableStringFromText(product.RegistDate)
		if err := s.upsertPartyCatalogItem(ctx, partyID, product.WorkNo, title, release, dlsiteURL(product.WorkNo), "catalog", raw); err != nil {
			return synced, err
		}
		party := parsedParty{ExternalID: normalizeMakerID(product.MakerID), DisplayName: strings.TrimSpace(product.MakerName)}
		if party.ExternalID == "" {
			party.ExternalID = normalizeMakerID(product.MakerID)
		}
		if dlsiteMakerIDPattern.MatchString(party.ExternalID) && party.DisplayName != "" {
			if _, err := s.upsertDLsiteParty(ctx, party.ExternalID, party.DisplayName, raw); err != nil {
				return synced, err
			}
		}
		synced++
	}
	return synced, nil
}

func (s *Server) knownCircleCatalogCodes(ctx context.Context, partyID int64) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT primary_code FROM party_catalog_item WHERE party_id = ?", partyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			result[code] = true
		}
	}
	return result, rows.Err()
}

func (s *Server) availableCircleCatalogCodes(ctx context.Context, partyID int64, workCodes []string) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT catalog.primary_code
		FROM party_catalog_item AS catalog
		INNER JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE catalog.party_id = ?
			AND location.availability = 'available'
	`, partyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			result[code] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	for _, code := range workCodes {
		code = strings.ToUpper(strings.TrimSpace(code))
		if code == "" || result[code] {
			continue
		}
		if s.circleWorkAvailableInAnyRemoteSource(ctx, sources, code) {
			result[code] = true
		}
	}
	return result, nil
}

func (s *Server) circleWorkAvailableInAnyRemoteSource(ctx context.Context, sources []remoteSourceForUse, code string) bool {
	for _, source := range sources {
		if source.SourceType != "kikoeru_compatible" || !source.Enabled {
			continue
		}
		if err := s.waitRemoteDownloadDelay(ctx); err != nil {
			return false
		}
		remoteWork, err := s.checkRemoteWorkAvailability(ctx, source, code)
		if err != nil {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			continue
		}
		_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		if normalizedRemoteWorkCode(remoteWork) != "" || remoteWork.ID > 0 {
			return true
		}
	}
	return false
}

func normalizeCircleRefreshRequest(request circleRefreshRequest) circleRefreshRequest {
	request.Mode = strings.ToLower(strings.TrimSpace(request.Mode))
	if request.Mode != "full" {
		request.Mode = "incremental"
	}
	request.ProductMode = strings.ToLower(strings.TrimSpace(request.ProductMode))
	if request.ProductMode != "all" {
		request.ProductMode = "available"
	}
	return request
}

func circleRefreshMaxPages(mode string) int {
	if mode == "full" {
		return 100
	}
	return 10
}

func (s *Server) circleRefreshDelay(ctx context.Context) time.Duration {
	base := s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)
	if base < 0.25 {
		base = 0.25
	}
	return time.Duration(base * float64(time.Second))
}

func nullableStringFromText(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func (s *Server) recordCircleRefreshWorkflow(ctx context.Context, partyID int64, externalID string, profile dlsite.MakerProfile, result circleRefreshResult) (int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "circle_metadata_refresh", "Refresh circle metadata", "Refresh DLsite maker profile and catalog for one circle.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_party"},
			{"id": "refresh", "type": "refresh_party_metadata"},
			{"id": "sources", "type": "check_source_availability"},
		},
	})
	if err != nil {
		return 0, 0, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "circle_metadata_refresh", "Refresh circle metadata", result.Status, "manual", "circle_shortcut", map[string]any{
		"party_id":    partyID,
		"external_id": externalID,
	}, map[string]any{
		"status":         result.Status,
		"catalog_works":  result.CatalogWorks,
		"pages_fetched":  result.PagesFetched,
		"product_synced": result.ProductSynced,
		"mode":           result.Mode,
		"product_mode":   result.ProductMode,
		"error":          result.Error,
	})
	if err != nil {
		return 0, 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "select",
		NodeType:    "select_party",
		DisplayName: "Select circle",
		Position:    1,
		Status:      "succeeded",
		Input:       map[string]any{"external_id": externalID},
		Output:      map[string]any{"party_id": partyID},
	}); err != nil {
		return 0, 0, err
	}
	refreshNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "refresh",
		NodeType:    "refresh_party_metadata",
		DisplayName: "Refresh circle metadata",
		Position:    2,
		Status:      result.Status,
		Input:       map[string]any{"external_id": externalID, "mode": result.Mode, "product_mode": result.ProductMode},
		Output:      map[string]any{"maker_name": profile.MakerName, "catalog_works": result.CatalogWorks, "pages_fetched": result.PagesFetched, "product_synced": result.ProductSynced, "url": profile.URL},
		Error:       result.Error,
	})
	if err != nil {
		return 0, 0, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID:       refreshNodeID,
		WorkerType:      "circle_metadata_refresh",
		Status:          result.Status,
		Payload:         map[string]any{"external_id": externalID, "mode": result.Mode, "product_mode": result.ProductMode},
		ProgressCurrent: result.CatalogWorks,
		ProgressTotal:   result.CatalogWorks,
		Error:           result.Error,
	})
	if err != nil {
		return 0, 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return runID, jobID, nil
}

func (s *Server) metadataProviderID(ctx context.Context, code string, displayName string) (int64, error) {
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO metadata_provider (code, display_name)
		VALUES (?, ?)
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name
	`, code, displayName); err != nil {
		return 0, err
	}
	var id int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = ?", code).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func lastInsertID(tx *sql.Tx) (int64, error) {
	var id int64
	if err := tx.QueryRow("SELECT last_insert_rowid()").Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func normalizeMakerID(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func nullableIntPointer(value sql.NullInt64) *int {
	if !value.Valid {
		return nil
	}
	next := int(value.Int64)
	return &next
}

func nullableStringValue(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func dlsiteMakerURL(externalID string) string {
	site := "maniax"
	if strings.HasPrefix(strings.ToUpper(externalID), "VG") {
		site = "pro"
	}
	return fmt.Sprintf("https://www.dlsite.com/%s/circle/profile/=/maker_id/%s.html", site, externalID)
}
