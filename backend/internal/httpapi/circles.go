package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metasync"
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
	AutoRefresh     circleAutoRefresh  `json:"autoRefresh"`
	SourceSummaries []circleSourceStat `json:"sourceSummaries"`
}

type circleAutoRefresh struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
	Mode   string `json:"mode"`
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
	WorkID           *int64              `json:"workId"`
	PrimaryCode      string              `json:"primaryCode"`
	Title            string              `json:"title"`
	ReleaseDate      *string             `json:"releaseDate"`
	UpdatedAt        string              `json:"updatedAt"`
	CoverURL         string              `json:"coverUrl"`
	DLsiteURL        string              `json:"dlsiteUrl"`
	Circle           string              `json:"circle"`
	CircleExternalID string              `json:"circleExternalId"`
	Tags             []string            `json:"tags"`
	Rating           *float64            `json:"rating"`
	Sales            *int64              `json:"sales"`
	CatalogStatus    string              `json:"catalogStatus"`
	DLsiteAvailable  bool                `json:"dlsiteAvailable"`
	ListeningMark    string              `json:"listeningMark"`
	Local            bool                `json:"local"`
	Remote           bool                `json:"remote"`
	SourceTags       []circleSourceStat  `json:"sourceTags"`
	Progress         workProgressSummary `json:"progress"`
}

type circleRefreshRequest struct {
	Scope       string `json:"scope"`
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
	if err := s.ensureWorkSourcePresenceSchema(r.Context()); err != nil {
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
				SELECT refresh.last_success_at
				FROM party_catalog_refresh_state AS refresh
				WHERE refresh.party_id = party.id AND refresh.provider_code = 'dlsite'
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
	partyIDs := []int64{}
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
		item.SourceSummaries = []circleSourceStat{}
		setDefaultCircleState(&item)
		items = append(items, item)
		partyIDs = append(partyIDs, item.ID)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	if err := s.fillCircleStatsBatch(r.Context(), items, partyIDs); err != nil {
		writeError(w, err)
		return
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
	if err := s.ensureWorkSourcePresenceSchema(r.Context()); err != nil {
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

func (s *Server) autoRefreshCircle(w http.ResponseWriter, r *http.Request) {
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
	if err := s.ensureWorkSourcePresenceSchema(r.Context()); err != nil {
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
	summary.AutoRefresh = s.maybeStartCircleAutoRefresh(partyID, externalID, summary.LastSyncedAt)
	writeJSON(w, http.StatusOK, summary.AutoRefresh)
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
	if err := s.ensureWorkSourcePresenceSchema(r.Context()); err != nil {
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
	if isTranslationUmbrellaCircle(externalID) && (circleRefreshIncludesCatalog(payload.Scope) || circleRefreshIncludesSource(payload.Scope)) {
		writeJSON(w, http.StatusAccepted, map[string]any{
			"runId":           0,
			"externalId":      externalID,
			"status":          "skipped",
			"scope":           payload.Scope,
			"catalogWorks":    0,
			"pagesFetched":    0,
			"productSynced":   0,
			"productSkipped":  0,
			"productFailed":   0,
			"productFailures": []string{},
			"sourceSynced":    0,
			"mode":            payload.Mode,
			"productMode":     payload.ProductMode,
			"reason":          "translation umbrella circle",
		})
		return
	}
	result, err := s.runCircleRefresh(r.Context(), partyID, externalID, payload)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{
		"runId":           result.RunID,
		"externalId":      externalID,
		"status":          result.Status,
		"scope":           result.Scope,
		"catalogWorks":    result.CatalogWorks,
		"pagesFetched":    result.PagesFetched,
		"productSynced":   result.ProductSynced,
		"productSkipped":  result.ProductSkipped,
		"productFailed":   result.ProductFailed,
		"productFailures": result.ProductFailures,
		"sourceSynced":    result.SourceSynced,
		"mode":            result.Mode,
		"productMode":     result.ProductMode,
	})
}

func (s *Server) deleteCircleCatalogWork(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if !regexp.MustCompile(`(?i)^(RJ|BJ|VJ)[0-9]{5,8}$`).MatchString(code) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return
	}
	if err := s.ensureCircleSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	providerID, err := s.metadataProviderID(r.Context(), "dlsite", "DLsite")
	if err != nil {
		writeError(w, err)
		return
	}
	partyID, err := s.ensurePlaceholderCircle(r.Context(), externalID)
	if err != nil {
		writeError(w, err)
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		DELETE FROM party_catalog_item
		WHERE party_id = ? AND provider_id = ? AND UPPER(primary_code) = ?
	`, partyID, providerID, code)
	if err != nil {
		writeError(w, err)
		return
	}
	deleted, _ := result.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
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
			dlsite_available INTEGER NOT NULL DEFAULT 1,
			raw_json TEXT NOT NULL DEFAULT '{}',
			last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(party_id, provider_id, primary_code)
		)`,
		`CREATE TABLE IF NOT EXISTS party_catalog_refresh_state (
			party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
			provider_code TEXT NOT NULL,
			last_success_at TEXT,
			last_attempt_at TEXT,
			last_mode TEXT NOT NULL DEFAULT '',
			last_status TEXT NOT NULL DEFAULT '',
			last_run_id INTEGER,
			last_error TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(party_id, provider_code)
		)`,
		`CREATE TABLE IF NOT EXISTS work_party (
			work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
			party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
			role TEXT NOT NULL DEFAULT 'circle',
			provider_id INTEGER REFERENCES metadata_provider(id),
			source TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(work_id, party_id, role)
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
	if _, err := s.db.ExecContext(ctx, "ALTER TABLE party_catalog_item ADD COLUMN dlsite_available INTEGER NOT NULL DEFAULT 1"); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "CREATE INDEX IF NOT EXISTS idx_work_party_party ON work_party(party_id, role)"); err != nil {
		return err
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
	type snapshotWork struct {
		WorkID  int64
		Code    string
		Title   string
		Release sql.NullString
		Raw     string
	}
	snapshots := []snapshotWork{}
	seenWork := map[int64]bool{}
	for rows.Next() {
		var snapshot snapshotWork
		if err := rows.Scan(&snapshot.WorkID, &snapshot.Code, &snapshot.Title, &snapshot.Release, &snapshot.Raw); err != nil {
			return err
		}
		if seenWork[snapshot.WorkID] {
			continue
		}
		seenWork[snapshot.WorkID] = true
		snapshots = append(snapshots, snapshot)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, snapshot := range snapshots {
		party := parsePartyFromDLsiteSnapshot(snapshot.Raw)
		if !dlsiteMakerIDPattern.MatchString(party.ExternalID) || party.DisplayName == "" {
			continue
		}
		partyID, err := s.upsertDLsiteParty(ctx, party.ExternalID, party.DisplayName, snapshot.Raw)
		if err != nil {
			return err
		}
		if err := s.upsertPartyCatalogItem(ctx, partyID, snapshot.Code, snapshot.Title, nullableStringValue(snapshot.Release), dlsiteURL(snapshot.Code), "imported", snapshot.Raw); err != nil {
			return err
		}
		if err := s.upsertWorkParty(ctx, snapshot.WorkID, partyID, "circle", "dlsite_snapshot"); err != nil {
			return err
		}
	}
	return nil
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
	return s.upsertPartyCatalogItemForProvider(ctx, partyID, providerID, code, title, releaseDate, url, status, raw, true)
}

func (s *Server) upsertPartyCatalogItemForProvider(ctx context.Context, partyID int64, providerID int64, code string, title string, releaseDate *string, url string, status string, raw string, dlsiteAvailable bool) error {
	available := 0
	if dlsiteAvailable {
		available = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, release_date, url, catalog_status, dlsite_available, raw_json, last_seen_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(party_id, provider_id, primary_code) DO UPDATE SET
			title = excluded.title,
			release_date = excluded.release_date,
			url = excluded.url,
			catalog_status = excluded.catalog_status,
			dlsite_available = excluded.dlsite_available,
			raw_json = excluded.raw_json,
			last_seen_at = CURRENT_TIMESTAMP
	`, partyID, providerID, strings.ToUpper(strings.TrimSpace(code)), title, releaseDate, url, status, available, raw)
	return err
}

func (s *Server) upsertWorkParty(ctx context.Context, workID int64, partyID int64, role string, source string) error {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, party_id, role) DO UPDATE SET
			provider_id = excluded.provider_id,
			source = excluded.source,
			updated_at = CURRENT_TIMESTAMP
	`, workID, partyID, strings.TrimSpace(firstNonEmpty(role, "circle")), providerID, source)
	return err
}

func upsertWorkPartyTx(ctx context.Context, tx *sql.Tx, providerID int64, workID int64, partyID int64, role string, source string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, party_id, role) DO UPDATE SET
			provider_id = excluded.provider_id,
			source = excluded.source,
			updated_at = CURRENT_TIMESTAMP
	`, workID, partyID, strings.TrimSpace(firstNonEmpty(role, "circle")), providerID, source)
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
				SELECT refresh.last_success_at
				FROM party_catalog_refresh_state AS refresh
				WHERE refresh.party_id = party.id AND refresh.provider_code = 'dlsite'
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
	setDefaultCircleState(item)
	var catalogWorks int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT primary_code) FROM party_catalog_item WHERE party_id = ?", item.ID).Scan(&catalogWorks); err != nil {
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
	if isTranslationUmbrellaCircle(item.ExternalID) {
		item.SyncState = "excluded"
	}
	return nil
}

func setDefaultCircleState(item *circleSummary) {
	if isTranslationUmbrellaCircle(item.ExternalID) {
		item.AutoRefresh = circleAutoRefresh{Status: "skipped", Reason: "translation umbrella circle", Mode: ""}
	}
	if item.AutoRefresh.Status == "" {
		item.AutoRefresh = circleAutoRefresh{Status: "skipped", Reason: "not evaluated"}
	}
	item.SyncState = "fresh"
	if item.LastSyncedAt == nil {
		item.SyncState = "pending"
	}
	if isTranslationUmbrellaCircle(item.ExternalID) {
		item.SyncState = "excluded"
	}
}

func (s *Server) fillCircleStatsBatch(ctx context.Context, items []circleSummary, partyIDs []int64) error {
	if len(items) == 0 {
		return nil
	}
	byID := map[int64]*circleSummary{}
	for index := range items {
		byID[items[index].ID] = &items[index]
	}
	catalogCounts, err := s.loadCircleCatalogCounts(ctx, partyIDs)
	if err != nil {
		return err
	}
	for partyID, count := range catalogCounts {
		if item := byID[partyID]; item != nil {
			item.CatalogWorks = count
		}
	}
	localCounts, remoteCounts, err := s.loadCircleAvailabilityCounts(ctx, partyIDs)
	if err != nil {
		return err
	}
	for partyID, count := range localCounts {
		if item := byID[partyID]; item != nil {
			item.LocalWorks = count
			item.PlayableWorks = count
		}
	}
	for partyID, count := range remoteCounts {
		if item := byID[partyID]; item != nil {
			item.RemoteWorks = count
		}
	}
	for index := range items {
		items[index].MissingWorks = items[index].CatalogWorks - items[index].LocalWorks - items[index].RemoteWorks
		if items[index].MissingWorks < 0 {
			items[index].MissingWorks = 0
		}
		if items[index].LastSyncedAt != nil && items[index].CatalogWorks == 0 && !isTranslationUmbrellaCircle(items[index].ExternalID) {
			items[index].SyncState = "stale"
		}
	}
	return nil
}

func (s *Server) loadCircleCatalogCounts(ctx context.Context, partyIDs []int64) (map[int64]int, error) {
	query, args := int64InQuery(`
		SELECT party_id, COUNT(DISTINCT primary_code)
		FROM party_catalog_item
		WHERE party_id IN (%s)
		GROUP BY party_id
	`, partyIDs)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[int64]int{}
	for rows.Next() {
		var partyID int64
		var count int
		if err := rows.Scan(&partyID, &count); err != nil {
			return nil, err
		}
		result[partyID] = count
	}
	return result, rows.Err()
}

func (s *Server) loadCircleAvailabilityCounts(ctx context.Context, partyIDs []int64) (map[int64]int, map[int64]int, error) {
	query, args := int64InQuery(`
		SELECT relation.party_id, location.location_type, COUNT(DISTINCT work.id)
		FROM work_party AS relation
		INNER JOIN work ON work.id = relation.work_id
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE relation.party_id IN (%s)
			AND location.availability = 'available'
		GROUP BY relation.party_id, location.location_type
	`, partyIDs)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	localCounts := map[int64]int{}
	remoteCounts := map[int64]int{}
	for rows.Next() {
		var partyID int64
		var locationType string
		var count int
		if err := rows.Scan(&partyID, &locationType, &count); err != nil {
			return nil, nil, err
		}
		if locationType == "local" {
			localCounts[partyID] += count
		} else {
			remoteCounts[partyID] += count
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	query, args = int64InQuery(`
		SELECT catalog.party_id, COUNT(DISTINCT catalog.primary_code)
		FROM party_catalog_item AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		INNER JOIN file_source AS source ON provider.code = 'kikoeru_source_' || source.code
		WHERE catalog.party_id IN (%s)
			AND source.source_type IN ('kikoeru_compatible', 'kikoeru_compilable_number178')
			AND source.enabled = 1
		GROUP BY catalog.party_id
	`, partyIDs)
	remoteRows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer remoteRows.Close()
	for remoteRows.Next() {
		var partyID int64
		var count int
		if err := remoteRows.Scan(&partyID, &count); err != nil {
			return nil, nil, err
		}
		if count > remoteCounts[partyID] {
			remoteCounts[partyID] = count
		}
	}
	if err := remoteRows.Err(); err != nil {
		return nil, nil, err
	}
	query, args = int64InQuery(`
		SELECT relation.party_id, COUNT(DISTINCT work.id)
		FROM work_party AS relation
		INNER JOIN work ON work.id = relation.work_id
		INNER JOIN work_source_presence AS presence ON presence.work_id = work.id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE relation.party_id IN (%s)
			AND presence.presence_type = 'remote'
			AND presence.availability = 'available'
			AND source.enabled = 1
		GROUP BY relation.party_id
	`, partyIDs)
	presenceRows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer presenceRows.Close()
	for presenceRows.Next() {
		var partyID int64
		var count int
		if err := presenceRows.Scan(&partyID, &count); err != nil {
			return nil, nil, err
		}
		if count > remoteCounts[partyID] {
			remoteCounts[partyID] = count
		}
	}
	if err := presenceRows.Err(); err != nil {
		return nil, nil, err
	}
	return localCounts, remoteCounts, nil
}

func int64InQuery(template string, values []int64) (string, []any) {
	placeholders := make([]string, 0, len(values))
	args := make([]any, 0, len(values))
	for _, value := range values {
		placeholders = append(placeholders, "?")
		args = append(args, value)
	}
	return fmt.Sprintf(template, strings.Join(placeholders, ",")), args
}

func (s *Server) circleSourceStats(ctx context.Context, partyID int64) ([]circleSourceStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, location.location_type, COUNT(DISTINCT work.id)
		FROM work_party AS relation
		INNER JOIN work ON work.id = relation.work_id
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE relation.party_id = ?
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	remoteRows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, COUNT(DISTINCT catalog.primary_code)
		FROM party_catalog_item AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		INNER JOIN file_source AS source ON provider.code = 'kikoeru_source_' || source.code
		WHERE catalog.party_id = ?
			AND source.source_type IN ('kikoeru_compatible', 'kikoeru_compilable_number178')
			AND source.enabled = 1
		GROUP BY source.id, source.display_name
	`, partyID)
	if err != nil {
		return nil, err
	}
	defer remoteRows.Close()
	for remoteRows.Next() {
		var sourceID int64
		var sourceName string
		var count int
		if err := remoteRows.Scan(&sourceID, &sourceName, &count); err != nil {
			return nil, err
		}
		statKey := fmt.Sprintf("source:%d", sourceID)
		stat := combined[statKey]
		if stat.Key == "" {
			stat = circleSourceStat{Key: statKey, SourceID: &sourceID, DisplayName: sourceName, Status: "available"}
		}
		if count > stat.Count {
			stat.Count = count
		}
		combined[statKey] = stat
	}
	if err := remoteRows.Err(); err != nil {
		return nil, err
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
	return result, nil
}

func (s *Server) loadCircleWorks(ctx context.Context, userID int64, partyID int64) ([]circleCatalogWork, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			codes.primary_code,
			COALESCE(dlsite_catalog.title, remote_catalog.title, codes.primary_code),
			COALESCE(dlsite_catalog.release_date, remote_catalog.release_date),
			COALESCE(dlsite_catalog.url, remote_catalog.url, ''),
			COALESCE(dlsite_catalog.catalog_status, remote_catalog.catalog_status, 'catalog'),
			COALESCE(dlsite_catalog.dlsite_available, 1),
			work.id,
			COALESCE((
				SELECT snapshot_json
				FROM metadata_snapshot
				WHERE metadata_snapshot.work_id = work.id
				ORDER BY fetched_at DESC, id DESC
				LIMIT 1
			), '') AS snapshot_json,
			COALESCE(user_work_state.listening_status, 'none')
		FROM (
			SELECT DISTINCT primary_code
			FROM party_catalog_item
			WHERE party_id = ?
		) AS codes
		LEFT JOIN metadata_provider AS dlsite_provider ON dlsite_provider.code = 'dlsite'
		LEFT JOIN party_catalog_item AS dlsite_catalog
			ON dlsite_catalog.party_id = ?
			AND dlsite_catalog.provider_id = dlsite_provider.id
			AND UPPER(dlsite_catalog.primary_code) = UPPER(codes.primary_code)
		LEFT JOIN party_catalog_item AS remote_catalog
			ON remote_catalog.id = (
				SELECT catalog.id
				FROM party_catalog_item AS catalog
				INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
				WHERE catalog.party_id = ?
					AND UPPER(catalog.primary_code) = UPPER(codes.primary_code)
					AND provider.code != 'dlsite'
				ORDER BY catalog.last_seen_at DESC, catalog.id DESC
				LIMIT 1
			)
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(codes.primary_code)
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		ORDER BY COALESCE(dlsite_catalog.release_date, remote_catalog.release_date, '') DESC, codes.primary_code DESC
		LIMIT 100
	`, partyID, partyID, partyID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	works := []circleCatalogWork{}
	for rows.Next() {
		var item circleCatalogWork
		var release sql.NullString
		var workID sql.NullInt64
		var dlsiteAvailable int
		var snapshot string
		if err := rows.Scan(&item.PrimaryCode, &item.Title, &release, &item.DLsiteURL, &item.CatalogStatus, &dlsiteAvailable, &workID, &snapshot, &item.ListeningMark); err != nil {
			return nil, err
		}
		metadata := parseDLsiteSnapshot(snapshot)
		item.Tags = metadata.Tags
		item.Rating = metadata.Rating
		item.Sales = metadata.Sales
		item.ReleaseDate = nullableString(release)
		if item.ReleaseDate != nil {
			item.UpdatedAt = *item.ReleaseDate
		}
		item.WorkID = nullableInt64(workID)
		item.DLsiteAvailable = dlsiteAvailable != 0
		item.CoverURL = s.coverURL(item.PrimaryCode)
		item.Circle = metadata.Circle
		item.CircleExternalID = metadata.CircleExternalID
		tags, err := s.workSourceTags(ctx, partyID, item.PrimaryCode)
		if err != nil {
			return nil, err
		}
		item.SourceTags = tags
		if item.WorkID != nil {
			progress, err := s.workProgressSummary(ctx, userID, *item.WorkID)
			if err != nil {
				return nil, err
			}
			item.Progress = progress
		}
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

func (s *Server) workSourceTags(ctx context.Context, partyID int64, code string) ([]circleSourceStat, error) {
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
	catalogRows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, COUNT(*)
		FROM party_catalog_item AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		INNER JOIN file_source AS source ON provider.code = 'kikoeru_source_' || source.code
		WHERE catalog.party_id = ?
			AND UPPER(catalog.primary_code) = UPPER(?)
			AND source.source_type IN ('kikoeru_compatible', 'kikoeru_compilable_number178')
			AND source.enabled = 1
		GROUP BY source.id, source.display_name
	`, partyID, code)
	if err != nil {
		return nil, err
	}
	defer catalogRows.Close()
	seenSource := map[int64]bool{}
	for _, tag := range tags {
		if tag.SourceID != nil {
			seenSource[*tag.SourceID] = true
		}
	}
	for catalogRows.Next() {
		var sourceID int64
		var sourceName string
		var count int
		if err := catalogRows.Scan(&sourceID, &sourceName, &count); err != nil {
			return nil, err
		}
		if seenSource[sourceID] {
			continue
		}
		hasRemote = true
		seenSource[sourceID] = true
		tags = append(tags, circleSourceStat{Key: fmt.Sprintf("source:%d", sourceID), SourceID: &sourceID, DisplayName: sourceName, Status: "available", Count: count})
	}
	if err := catalogRows.Err(); err != nil {
		return nil, err
	}
	presenceRows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, COUNT(*)
		FROM work
		INNER JOIN work_source_presence AS presence ON presence.work_id = work.id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE UPPER(work.primary_code) = UPPER(?)
			AND presence.presence_type = 'remote'
			AND presence.availability = 'available'
			AND source.enabled = 1
		GROUP BY source.id, source.display_name
	`, code)
	if err != nil {
		return nil, err
	}
	defer presenceRows.Close()
	for presenceRows.Next() {
		var sourceID int64
		var sourceName string
		var count int
		if err := presenceRows.Scan(&sourceID, &sourceName, &count); err != nil {
			return nil, err
		}
		if seenSource[sourceID] {
			continue
		}
		hasRemote = true
		seenSource[sourceID] = true
		tags = append(tags, circleSourceStat{Key: fmt.Sprintf("source:%d", sourceID), SourceID: &sourceID, DisplayName: sourceName, Status: "available", Count: count})
	}
	if err := presenceRows.Err(); err != nil {
		return nil, err
	}
	if hasRemote {
		tags = append([]circleSourceStat{{Key: "remote", DisplayName: "Remote", Status: "available", Count: 1}}, tags...)
	}
	return tags, rows.Err()
}

type circleRefreshResult struct {
	RunID           int64
	JobID           int64
	Status          string
	Scope           string
	CatalogWorks    int
	PagesFetched    int
	ProductSynced   int
	SourceSynced    int
	ProductFailed   int
	ProductSkipped  int
	ProductFailures []string
	Mode            string
	ProductMode     string
	Error           string
}

func (s *Server) runCircleRefresh(ctx context.Context, partyID int64, externalID string, request circleRefreshRequest) (circleRefreshResult, error) {
	client := dlsite.NewClient(nil)
	profile := dlsite.MakerProfile{MakerID: externalID}
	result := circleRefreshResult{Status: "succeeded", Scope: request.Scope, Mode: request.Mode, ProductMode: request.ProductMode}

	if circleRefreshIncludesCatalog(request.Scope) {
		fetchedProfile, err := s.runCircleCatalogRefresh(ctx, partyID, externalID, request.Mode, client)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
		} else {
			profile = fetchedProfile
			result.CatalogWorks = len(profile.WorkCodes)
			result.PagesFetched = profile.PagesFetched
		}
	} else {
		fallbackProfile, err := s.loadCircleProfileForRefresh(ctx, partyID, externalID)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
		} else {
			profile = fallbackProfile
			result.CatalogWorks = len(profile.WorkCodes)
		}
	}

	if result.Status != "failed" && circleRefreshIncludesWork(request.Scope) {
		productResult, err := s.syncCircleProductJSON(ctx, partyID, profile.WorkCodes, request.ProductMode, client)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
		} else {
			result.ProductSynced = productResult.Synced
			result.ProductSkipped = productResult.Skipped
			result.ProductFailed = len(productResult.Failures)
			result.ProductFailures = productResult.Failures
			if result.ProductFailed > 0 {
				result.Status = "partial"
			}
		}
	}

	if result.Status != "failed" && circleRefreshIncludesSource(request.Scope) {
		sourceSynced, err := s.syncCircleRemoteSourceCatalogs(ctx, partyID, profile.MakerName, request.Mode)
		if err != nil {
			result.Status = "failed"
			result.Error = err.Error()
		} else {
			result.SourceSynced = sourceSynced
		}
	}

	runID, jobID, err := s.recordCircleRefreshWorkflow(ctx, partyID, externalID, profile, result)
	if err != nil {
		return circleRefreshResult{}, err
	}
	result.RunID = runID
	result.JobID = jobID
	if circleRefreshIncludesCatalog(request.Scope) {
		if err := s.recordCircleCatalogRefreshAttempt(ctx, partyID, "dlsite", result); err != nil {
			return circleRefreshResult{}, err
		}
	}
	if result.Status == "failed" {
		return result, fmt.Errorf("%s", result.Error)
	}
	return result, nil
}

func (s *Server) runCircleCatalogRefresh(ctx context.Context, partyID int64, externalID string, mode string, client *dlsite.Client) (dlsite.MakerProfile, error) {
	knownCodes, err := s.knownCircleCatalogCodes(ctx, partyID)
	if err != nil {
		return dlsite.MakerProfile{}, err
	}
	profile, err := client.FetchMakerCatalog(ctx, externalID, dlsite.MakerCatalogOptions{
		Mode:           mode,
		MaxPages:       circleRefreshMaxPages(mode),
		KnownWorkCodes: knownCodes,
		Delay:          s.circleRefreshDelay(ctx),
	})
	if err != nil {
		return profile, err
	}
	if err := s.applyMakerProfile(ctx, partyID, profile, mode == "full"); err != nil {
		return profile, err
	}
	if err := s.recordCircleCatalogRefreshSuccess(ctx, partyID, "dlsite", mode); err != nil {
		return profile, err
	}
	return profile, nil
}

func (s *Server) loadCircleProfileForRefresh(ctx context.Context, partyID int64, externalID string) (dlsite.MakerProfile, error) {
	profile := dlsite.MakerProfile{MakerID: externalID}
	var name string
	if err := s.db.QueryRowContext(ctx, "SELECT display_name FROM party WHERE id = ?", partyID).Scan(&name); err != nil {
		return profile, err
	}
	profile.MakerName = strings.TrimSpace(name)
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT primary_code
		FROM party_catalog_item
		WHERE party_id = ?
		ORDER BY last_seen_at DESC, id DESC
	`, partyID)
	if err != nil {
		return profile, err
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return profile, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			profile.WorkCodes = append(profile.WorkCodes, code)
		}
	}
	return profile, rows.Err()
}

func (s *Server) maybeStartCircleAutoRefresh(partyID int64, externalID string, lastSyncedAt *string) circleAutoRefresh {
	if isTranslationUmbrellaCircle(externalID) {
		return circleAutoRefresh{Status: "skipped", Reason: "translation umbrella circle", Mode: ""}
	}
	days := s.settingIntContext(context.Background(), "circle_auto_refresh_days", 30)
	if days <= 0 {
		return circleAutoRefresh{Status: "disabled", Reason: "auto refresh disabled"}
	}
	mode := "incremental"
	reason := "stale"
	if lastSyncedAt == nil {
		mode = "full"
		reason = "first pull"
	} else if !circleRefreshDue(*lastSyncedAt, days) {
		return circleAutoRefresh{Status: "skipped", Reason: "fresh", Mode: mode}
	}
	if !s.markCircleAutoRefreshRunning(partyID) {
		return circleAutoRefresh{Status: "running", Reason: reason, Mode: mode}
	}
	go func() {
		defer s.clearCircleAutoRefreshRunning(partyID)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		request := normalizeCircleRefreshRequest(circleRefreshRequest{Scope: "all", Mode: mode, ProductMode: "available"})
		_, _ = s.runCircleRefresh(ctx, partyID, externalID, request)
	}()
	return circleAutoRefresh{Status: "queued", Reason: reason, Mode: mode}
}

func (s *Server) markCircleAutoRefreshRunning(partyID int64) bool {
	s.circleAutoRefreshMu.Lock()
	defer s.circleAutoRefreshMu.Unlock()
	if s.circleAutoRefreshing[partyID] {
		return false
	}
	s.circleAutoRefreshing[partyID] = true
	return true
}

func (s *Server) clearCircleAutoRefreshRunning(partyID int64) {
	s.circleAutoRefreshMu.Lock()
	defer s.circleAutoRefreshMu.Unlock()
	delete(s.circleAutoRefreshing, partyID)
}

func circleRefreshDue(lastSyncedAt string, days int) bool {
	last, err := parseSQLiteTime(lastSyncedAt)
	if err != nil {
		return true
	}
	return time.Since(last) >= time.Duration(days)*24*time.Hour
}

func parseSQLiteTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05Z07:00"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid time %q", value)
}

func (s *Server) recordCircleCatalogRefreshSuccess(ctx context.Context, partyID int64, providerCode string, mode string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO party_catalog_refresh_state (party_id, provider_code, last_success_at, last_attempt_at, last_mode, last_status, last_error, updated_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'catalog_synced', '', CURRENT_TIMESTAMP)
		ON CONFLICT(party_id, provider_code) DO UPDATE SET
			last_success_at = excluded.last_success_at,
			last_attempt_at = excluded.last_attempt_at,
			last_mode = excluded.last_mode,
			last_status = excluded.last_status,
			last_error = '',
			updated_at = CURRENT_TIMESTAMP
	`, partyID, providerCode, time.Now().UTC().Format(time.RFC3339), mode)
	return err
}

func (s *Server) recordCircleCatalogRefreshAttempt(ctx context.Context, partyID int64, providerCode string, result circleRefreshResult) error {
	errorText := result.Error
	if errorText == "" && result.Status == "failed" {
		errorText = "refresh failed"
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO party_catalog_refresh_state (party_id, provider_code, last_attempt_at, last_mode, last_status, last_run_id, last_error, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(party_id, provider_code) DO UPDATE SET
			last_attempt_at = excluded.last_attempt_at,
			last_mode = excluded.last_mode,
			last_status = excluded.last_status,
			last_run_id = excluded.last_run_id,
			last_error = excluded.last_error,
			updated_at = CURRENT_TIMESTAMP
	`, partyID, providerCode, result.Mode, result.Status, nullableRunID(result.RunID), errorText)
	return err
}

func nullableRunID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
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
		"total_works":   profile.TotalWorks,
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
		if _, err := tx.ExecContext(ctx, "UPDATE party_catalog_item SET dlsite_available = 0 WHERE party_id = ? AND provider_id = ?", partyID, providerID); err != nil {
			return err
		}
	}
	for _, code := range profile.WorkCodes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, url, catalog_status, dlsite_available, raw_json, last_seen_at)
			VALUES (?, ?, ?, ?, ?, 'catalog', 1, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(party_id, provider_id, primary_code) DO UPDATE SET
				url = excluded.url,
				catalog_status = CASE
					WHEN party_catalog_item.catalog_status = 'imported' THEN party_catalog_item.catalog_status
					ELSE excluded.catalog_status
				END,
				dlsite_available = 1,
				raw_json = excluded.raw_json,
				last_seen_at = CURRENT_TIMESTAMP
		`, partyID, providerID, code, code, dlsiteURL(code), string(raw)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type circleProductSyncResult struct {
	Synced   int
	Skipped  int
	Failures []string
}

func (s *Server) syncCircleProductJSON(ctx context.Context, partyID int64, workCodes []string, productMode string, client *dlsite.Client) (circleProductSyncResult, error) {
	if len(workCodes) == 0 {
		return circleProductSyncResult{}, nil
	}
	candidates := workCodes
	if productMode != "all" {
		missing, err := s.circleCatalogCodesMissingMetadata(ctx, partyID, workCodes)
		if err != nil {
			return circleProductSyncResult{}, err
		}
		filtered := []string{}
		for _, code := range workCodes {
			if missing[strings.ToUpper(strings.TrimSpace(code))] {
				filtered = append(filtered, code)
			}
		}
		candidates = filtered
	}
	syncer := metasync.NewDLsiteSyncer(s.db, client).WithCacheRoot(s.cfg.CacheRoot)
	result := circleProductSyncResult{Skipped: len(workCodes) - len(candidates), Failures: []string{}}
	for _, code := range candidates {
		if err := s.waitRemoteDownloadDelay(ctx); err != nil {
			return result, err
		}
		product, err := client.FetchProduct(ctx, code)
		if err != nil {
			result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", strings.ToUpper(strings.TrimSpace(code)), err.Error()))
			continue
		}
		raw := string(product.Raw)
		title := firstNonEmpty(product.WorkName, product.ProductName, product.WorkNo)
		release := nullableStringFromText(product.RegistDate)
		if err := s.upsertPartyCatalogItem(ctx, partyID, product.WorkNo, title, release, dlsiteURL(product.WorkNo), "catalog", raw); err != nil {
			return result, err
		}
		workID, err := syncer.SyncProduct(ctx, product)
		if err != nil {
			return result, err
		}
		if err := s.upsertWorkParty(ctx, workID, partyID, "circle", "circle_refresh"); err != nil {
			return result, err
		}
		party := parsedParty{ExternalID: normalizeMakerID(product.MakerID), DisplayName: strings.TrimSpace(product.MakerName)}
		if party.ExternalID == "" {
			party.ExternalID = normalizeMakerID(product.MakerID)
		}
		if dlsiteMakerIDPattern.MatchString(party.ExternalID) && party.DisplayName != "" {
			syncedPartyID, err := s.upsertDLsiteParty(ctx, party.ExternalID, party.DisplayName, raw)
			if err != nil {
				return result, err
			}
			if productPartyID := syncedPartyID; productPartyID > 0 {
				var workID int64
				if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", strings.ToUpper(strings.TrimSpace(product.WorkNo))).Scan(&workID); err == nil {
					if err := s.upsertWorkParty(ctx, workID, productPartyID, "circle", "dlsite_product"); err != nil {
						return result, err
					}
				}
			}
		}
		result.Synced++
	}
	return result, nil
}

func (s *Server) syncCircleRemoteSourceCatalogs(ctx context.Context, partyID int64, circleName string, mode string) (int, error) {
	circleName = strings.TrimSpace(circleName)
	if circleName == "" || strings.HasPrefix(circleName, "Unfetched circle ") {
		return 0, nil
	}
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return 0, err
	}
	totalSynced := 0
	for _, source := range sources {
		if !isKikoeruSourceType(source.SourceType) || !source.Enabled || strings.TrimSpace(source.Endpoint.APIURL) == "" {
			continue
		}
		synced, err := s.syncCircleRemoteSourceCatalog(ctx, partyID, circleName, source, mode)
		if err != nil {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			return totalSynced, err
		}
		if synced > 0 {
			_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		}
		totalSynced += synced
	}
	return totalSynced, nil
}

func (s *Server) syncCircleRemoteSourceCatalog(ctx context.Context, partyID int64, circleName string, source remoteSourceForUse, mode string) (int, error) {
	providerID, err := s.metadataProviderID(ctx, "kikoeru_source_"+source.Code, source.DisplayName)
	if err != nil {
		return 0, err
	}
	knownCodes, err := s.knownCircleCatalogCodesForProvider(ctx, partyID, providerID)
	if err != nil {
		return 0, err
	}
	client := kikoeruClientForSource(source)
	keyword := "$circle:" + circleName + "$"
	pageSize := 20
	maxPages := 10
	if mode == "full" {
		maxPages = 100
	}
	synced := 0
	for page := 1; page <= maxPages; page++ {
		if err := s.waitRemoteDownloadDelay(ctx); err != nil {
			return synced, err
		}
		worksPage, err := client.ListWorks(ctx, page, pageSize, keyword)
		if err != nil {
			return synced, err
		}
		pageCodes := []string{}
		remoteWorks := map[string]kikoeru.Work{}
		for _, remoteWork := range worksPage.Works {
			code := normalizedRemoteWorkCode(remoteWork)
			if code == "" {
				continue
			}
			code = strings.ToUpper(strings.TrimSpace(code))
			pageCodes = append(pageCodes, code)
			remoteWorks[code] = remoteWork
		}
		if mode != "full" {
			if beforeKnown, foundKnown := codesBeforeFirstKnown(pageCodes, knownCodes); foundKnown {
				pageCodes = beforeKnown
				for _, code := range pageCodes {
					if remoteWork, ok := remoteWorks[code]; ok {
						if err := s.upsertRemoteSourceCatalogWork(ctx, partyID, providerID, source, remoteWork); err != nil {
							return synced, err
						}
						synced++
					}
				}
				break
			}
		}
		for _, code := range pageCodes {
			remoteWork, ok := remoteWorks[code]
			if !ok {
				continue
			}
			if err := s.upsertRemoteSourceCatalogWork(ctx, partyID, providerID, source, remoteWork); err != nil {
				return synced, err
			}
			synced++
		}
		total := worksPage.Pagination.TotalCount
		if total == 0 {
			total = worksPage.Pagination.Total
		}
		if total == 0 {
			total = worksPage.Pagination.Count
		}
		if pages := pagesFromTotal(total, pageSize); pages > 0 && page >= pages {
			break
		}
		if total == 0 && (len(worksPage.Works) == 0 || len(worksPage.Works) < pageSize) {
			break
		}
	}
	return synced, nil
}

func (s *Server) upsertRemoteSourceCatalogWork(ctx context.Context, partyID int64, providerID int64, source remoteSourceForUse, remoteWork kikoeru.Work) error {
	code := normalizedRemoteWorkCode(remoteWork)
	if code == "" {
		return nil
	}
	raw, err := json.Marshal(remoteWork)
	if err != nil {
		return err
	}
	title := firstNonEmpty(remoteWork.Title, remoteWork.Name, code)
	release := nullableStringFromText(normalizeDateText(remoteWork.Release))
	if err := s.upsertPartyCatalogItemForProvider(ctx, partyID, providerID, code, title, release, remoteWork.SourceURL, "remote_catalog", string(raw), true); err != nil {
		return err
	}
	if err := s.ensureWorkSourcePresenceSchema(ctx); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, raw)
	if err != nil {
		return err
	}
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: "remote",
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		SourceURL:    remoteWork.SourceURL,
		Availability: "available",
		RawJSON:      string(raw),
	}); err != nil {
		return err
	}
	if err := upsertWorkPartyTx(ctx, tx, providerID, workID, partyID, "circle", "remote_source_catalog"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) knownCircleCatalogCodes(ctx context.Context, partyID int64) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT primary_code FROM party_catalog_item WHERE party_id = ?", partyID)
	if err != nil {
		return nil, err
	}
	return scanCatalogCodeRows(rows)
}

func (s *Server) knownCircleCatalogCodesForProvider(ctx context.Context, partyID int64, providerID int64) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT primary_code FROM party_catalog_item WHERE party_id = ? AND provider_id = ?", partyID, providerID)
	if err != nil {
		return nil, err
	}
	return scanCatalogCodeRows(rows)
}

func scanCatalogCodeRows(rows *sql.Rows) (map[string]bool, error) {
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

func (s *Server) circleCatalogCodesMissingMetadata(ctx context.Context, partyID int64, workCodes []string) (map[string]bool, error) {
	wanted := map[string]bool{}
	for _, code := range workCodes {
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			wanted[code] = true
		}
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT catalog.primary_code
		FROM party_catalog_item AS catalog
		LEFT JOIN metadata_provider AS provider ON provider.code = 'dlsite'
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		WHERE catalog.party_id = ?
			AND NOT EXISTS (
				SELECT 1
				FROM metadata_snapshot AS snapshot
				WHERE snapshot.work_id = work.id
					AND snapshot.provider_id = provider.id
			)
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
		if code != "" && wanted[code] {
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
	catalogRows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT catalog.primary_code
		FROM party_catalog_item AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		WHERE catalog.party_id = ?
			AND provider.code != 'dlsite'
	`, partyID)
	if err != nil {
		return nil, err
	}
	defer catalogRows.Close()
	for catalogRows.Next() {
		var code string
		if err := catalogRows.Scan(&code); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			result[code] = true
		}
	}
	if err := catalogRows.Err(); err != nil {
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
		if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
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
	request.Scope = strings.ToLower(strings.TrimSpace(request.Scope))
	switch request.Scope {
	case "catalog", "work", "source":
	default:
		request.Scope = "all"
	}
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

func circleRefreshIncludesCatalog(scope string) bool {
	return scope == "all" || scope == "catalog"
}

func circleRefreshIncludesWork(scope string) bool {
	return scope == "all" || scope == "work"
}

func circleRefreshIncludesSource(scope string) bool {
	return scope == "all" || scope == "source"
}

func scopedNodeStatus(result circleRefreshResult, included bool) string {
	if !included {
		return "skipped"
	}
	return result.Status
}

func scopedNodeError(result circleRefreshResult, status string) string {
	if status != "failed" {
		return ""
	}
	return result.Error
}

func circleRefreshMaxPages(mode string) int {
	if mode == "full" {
		return 100
	}
	return 10
}

func codesBeforeFirstKnown(codes []string, known map[string]bool) ([]string, bool) {
	if len(known) == 0 {
		return codes, false
	}
	for index, code := range codes {
		if known[strings.ToUpper(strings.TrimSpace(code))] {
			return codes[:index], true
		}
	}
	return codes, false
}

func pagesFromTotal(total int, perPage int) int {
	if total <= 0 || perPage <= 0 {
		return 0
	}
	return (total + perPage - 1) / perPage
}

func (s *Server) circleRefreshDelay(ctx context.Context) time.Duration {
	base := s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)
	if base < 0.25 {
		base = 0.25
	}
	return time.Duration(base * float64(time.Second))
}

func normalizeDateText(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) >= 10 {
		return value[:10]
	}
	return value
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
			{"id": "catalog", "type": "refresh_circle_catalog"},
			{"id": "work", "type": "sync_metadata"},
			{"id": "source", "type": "check_source_availability"},
		},
	})
	if err != nil {
		return 0, 0, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "circle_metadata_refresh", "Refresh circle metadata", result.Status, "manual", "circle_shortcut", map[string]any{
		"party_id":    partyID,
		"external_id": externalID,
		"scope":       result.Scope,
	}, map[string]any{
		"status":           result.Status,
		"scope":            result.Scope,
		"catalog_works":    result.CatalogWorks,
		"pages_fetched":    result.PagesFetched,
		"product_synced":   result.ProductSynced,
		"product_skipped":  result.ProductSkipped,
		"product_failed":   result.ProductFailed,
		"product_failures": result.ProductFailures,
		"source_synced":    result.SourceSynced,
		"mode":             result.Mode,
		"product_mode":     result.ProductMode,
		"error":            result.Error,
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
	catalogStatus := scopedNodeStatus(result, circleRefreshIncludesCatalog(result.Scope))
	catalogNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "catalog",
		NodeType:    "refresh_circle_catalog",
		DisplayName: "Refresh catalog",
		Position:    2,
		Status:      catalogStatus,
		Input:       map[string]any{"external_id": externalID, "mode": result.Mode},
		Output:      map[string]any{"maker_name": profile.MakerName, "catalog_works": result.CatalogWorks, "pages_fetched": result.PagesFetched, "url": profile.URL},
		Error:       scopedNodeError(result, catalogStatus),
	})
	if err != nil {
		return 0, 0, err
	}
	workStatus := scopedNodeStatus(result, circleRefreshIncludesWork(result.Scope))
	workNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "work",
		NodeType:    "sync_metadata",
		DisplayName: "Sync work metadata",
		Position:    3,
		Status:      workStatus,
		Input:       map[string]any{"external_id": externalID, "product_mode": result.ProductMode},
		Output:      map[string]any{"product_synced": result.ProductSynced, "product_skipped": result.ProductSkipped, "product_failed": result.ProductFailed, "product_failures": result.ProductFailures, "catalog_works": result.CatalogWorks},
		Error:       scopedNodeError(result, workStatus),
	})
	if err != nil {
		return 0, 0, err
	}
	sourceStatus := scopedNodeStatus(result, circleRefreshIncludesSource(result.Scope))
	sourceNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "source",
		NodeType:    "check_source_availability",
		DisplayName: "Find available sources",
		Position:    4,
		Status:      sourceStatus,
		Input:       map[string]any{"external_id": externalID, "mode": result.Mode},
		Output:      map[string]any{"source_synced": result.SourceSynced},
		Error:       scopedNodeError(result, sourceStatus),
	})
	if err != nil {
		return 0, 0, err
	}
	jobNodeID := catalogNodeID
	if result.Scope == "work" {
		jobNodeID = workNodeID
	} else if result.Scope == "source" {
		jobNodeID = sourceNodeID
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID:       jobNodeID,
		WorkerType:      "circle_metadata_refresh",
		Status:          result.Status,
		Payload:         map[string]any{"external_id": externalID, "scope": result.Scope, "mode": result.Mode, "product_mode": result.ProductMode},
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

func isTranslationUmbrellaCircle(externalID string) bool {
	return normalizeMakerID(externalID) == "RG60289"
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
