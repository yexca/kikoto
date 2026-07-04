package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const voiceRemotePageSize = 48

type voiceSummary struct {
	PersonID        int64              `json:"personId"`
	DisplayName     string             `json:"displayName"`
	Aliases         []string           `json:"aliases"`
	KnownWorks      int                `json:"knownWorks"`
	LocalWorks      int                `json:"localWorks"`
	RemoteWorks     int                `json:"remoteWorks"`
	CachedWorks     int                `json:"cachedWorks"`
	PlayableWorks   int                `json:"playableWorks"`
	LastSeenAt      *string            `json:"lastSeenAt"`
	Rating          *int               `json:"rating"`
	Note            string             `json:"note"`
	Favorite        bool               `json:"favorite"`
	UserTags        []voiceUserTag     `json:"userTags"`
	SourceSummaries []circleSourceStat `json:"sourceSummaries"`
}

type voiceUserTag struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

type voiceDetail struct {
	voiceSummary
	Works         []voiceKnownWork       `json:"works"`
	RemoteMatches []voiceRemoteSourceSet `json:"remoteMatches"`
}

type voiceKnownWork struct {
	WorkID           int64              `json:"workId"`
	PrimaryCode      string             `json:"primaryCode"`
	Title            string             `json:"title"`
	ReleaseDate      *string            `json:"releaseDate"`
	CoverURL         string             `json:"coverUrl"`
	DLsiteURL        string             `json:"dlsiteUrl"`
	Circle           string             `json:"circle"`
	CircleExternalID string             `json:"circleExternalId"`
	Rating           *float64           `json:"rating"`
	Tags             []string           `json:"tags"`
	ListeningMark    string             `json:"listeningMark"`
	Local            bool               `json:"local"`
	Remote           bool               `json:"remote"`
	Cache            bool               `json:"cache"`
	SourceTags       []circleSourceStat `json:"sourceTags"`
}

type voiceRemoteSourceSet struct {
	SourceID    int64             `json:"sourceId"`
	SourceCode  string            `json:"sourceCode"`
	DisplayName string            `json:"displayName"`
	Status      string            `json:"status"`
	Error       string            `json:"error"`
	ElapsedMS   int64             `json:"elapsedMs"`
	Total       int               `json:"total"`
	Works       []voiceRemoteWork `json:"works"`
}

type voiceRemoteWork struct {
	SourceID       int64    `json:"sourceId"`
	SourceCode     string   `json:"sourceCode"`
	SourceName     string   `json:"sourceName"`
	RemoteID       string   `json:"remoteId"`
	PrimaryCode    string   `json:"primaryCode"`
	Title          string   `json:"title"`
	CoverURL       string   `json:"coverUrl"`
	Circle         string   `json:"circle"`
	Rating         *float64 `json:"rating"`
	Tags           []string `json:"tags"`
	ImportStatus   string   `json:"importStatus"`
	RemotePlayable bool     `json:"remotePlayable"`
	WorkID         *int64   `json:"workId"`
	HasLocal       bool     `json:"hasLocal"`
	HasCache       bool     `json:"hasCache"`
	HasRemote      bool     `json:"hasRemote"`
}

func (s *Server) listVoices(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if err := s.ensureVoiceSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	if err := s.syncVoiceCreditsFromSnapshots(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	summaries, err := s.loadVoiceSummaries(r.Context(), user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summaries)
}

func (s *Server) getVoice(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	if err := s.ensureVoiceSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	if err := s.syncVoiceCreditsFromSnapshots(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	summary, err := s.loadVoiceSummary(r.Context(), user.ID, personID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	works, err := s.loadVoiceKnownWorks(r.Context(), user.ID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	matches, err := s.searchVoiceRemoteSources(r.Context(), summary.PersonID, summary.DisplayName)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, voiceDetail{voiceSummary: summary, Works: works, RemoteMatches: matches})
}

func (s *Server) updateVoiceUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
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
	if err := s.ensureVoiceSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
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
		INSERT INTO user_person_state (user_id, person_id, rating, note, favorite, updated_at)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, person_id) DO UPDATE SET
			rating = excluded.rating,
			note = excluded.note,
			favorite = excluded.favorite,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, personID, ratingValue, note, favorite); err != nil {
		writeError(w, err)
		return
	}
	summary, err := s.loadVoiceSummary(r.Context(), user.ID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) setVoiceUserTags(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "tags:write")
	if !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	var payload struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := s.ensureVoiceSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	tags, err := s.replaceVoiceUserTags(r.Context(), user.ID, personID, payload.Tags)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"personId": personID, "userTags": tags})
}

func (s *Server) loadVoiceSummaries(ctx context.Context, userID int64) ([]voiceSummary, error) {
	rows, err := s.db.QueryContext(ctx, voiceSummaryQuery("")+" ORDER BY known_works DESC, person.display_name ASC", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	summaries := []voiceSummary{}
	for rows.Next() {
		item, err := s.scanVoiceSummary(ctx, rows, userID)
		if err != nil {
			return nil, err
		}
		summaries = append(summaries, item)
	}
	return summaries, rows.Err()
}

func (s *Server) loadVoiceSummary(ctx context.Context, userID int64, personID int64) (voiceSummary, error) {
	row := s.db.QueryRowContext(ctx, voiceSummaryQuery("WHERE person.id = ?"), userID, personID)
	return s.scanVoiceSummary(ctx, row, userID)
}

func voiceSummaryQuery(where string) string {
	return `
		SELECT
			person.id,
			person.display_name,
			COALESCE((
				SELECT GROUP_CONCAT(alias.alias, char(31))
				FROM person_alias AS alias
				WHERE alias.person_id = person.id
			), '') AS aliases,
			COUNT(DISTINCT credit.work_id) AS known_works,
			COUNT(DISTINCT CASE WHEN EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = credit.work_id AND location.location_type = 'local' AND location.availability = 'available'
			) THEN credit.work_id END) AS local_works,
			COUNT(DISTINCT CASE WHEN EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = credit.work_id AND location.location_type IN ('remote_stream', 'remote_download') AND location.availability = 'available'
			) THEN credit.work_id END) AS remote_works,
			COUNT(DISTINCT CASE WHEN EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = credit.work_id AND location.location_type = 'cache' AND location.availability = 'available'
			) THEN credit.work_id END) AS cached_works,
			MAX(work.updated_at) AS last_seen_at,
			state.rating,
			COALESCE(state.note, '') AS note,
			COALESCE(state.favorite, 0) AS favorite
		FROM person
		INNER JOIN work_credit AS credit ON credit.person_id = person.id AND credit.role = 'voice_actor'
		INNER JOIN work ON work.id = credit.work_id
		LEFT JOIN user_person_state AS state ON state.person_id = person.id AND state.user_id = ?
		` + where + `
		GROUP BY person.id, person.display_name, state.rating, state.note, state.favorite
	`
}

type voiceSummaryScanner interface {
	Scan(dest ...any) error
}

func (s *Server) scanVoiceSummary(ctx context.Context, scanner voiceSummaryScanner, userID int64) (voiceSummary, error) {
	var item voiceSummary
	var aliasesRaw string
	var lastSeen sql.NullString
	var rating sql.NullInt64
	var favorite int
	if err := scanner.Scan(
		&item.PersonID,
		&item.DisplayName,
		&aliasesRaw,
		&item.KnownWorks,
		&item.LocalWorks,
		&item.RemoteWorks,
		&item.CachedWorks,
		&lastSeen,
		&rating,
		&item.Note,
		&favorite,
	); err != nil {
		return voiceSummary{}, err
	}
	item.Aliases = splitAliases(aliasesRaw)
	item.PlayableWorks = maxInt(item.LocalWorks, countUnionInts(item.LocalWorks, item.CachedWorks, item.RemoteWorks))
	item.LastSeenAt = nullableString(lastSeen)
	if rating.Valid {
		value := int(rating.Int64)
		item.Rating = &value
	}
	item.Favorite = favorite != 0
	tags, err := s.loadVoiceUserTags(ctx, userID, item.PersonID)
	if err != nil {
		return voiceSummary{}, err
	}
	item.UserTags = tags
	item.SourceSummaries = voiceSourceSummaries(item.LocalWorks, item.RemoteWorks, item.CachedWorks)
	return item, nil
}

func (s *Server) loadVoiceKnownWorks(ctx context.Context, userID int64, personID int64) ([]voiceKnownWork, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			work.id,
			work.primary_code,
			work.title,
			work.release_date,
			COALESCE((
				SELECT snapshot_json
				FROM metadata_snapshot
				WHERE metadata_snapshot.work_id = work.id
				ORDER BY fetched_at DESC, id DESC
				LIMIT 1
			), '') AS snapshot_json,
			(
				SELECT party.display_name || '|' || COALESCE(external.external_id, '')
				FROM work_party AS relation
				INNER JOIN party ON party.id = relation.party_id
				LEFT JOIN party_external_id AS external ON external.party_id = party.id
					AND external.is_primary = 1
				WHERE relation.work_id = work.id
					AND relation.role = 'circle'
				ORDER BY relation.updated_at DESC
				LIMIT 1
			) AS party_link,
			COALESCE(user_work_state.listening_status, 'none') AS listening_status,
			EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = work.id AND location.location_type = 'local' AND location.availability = 'available'
			) AS has_local,
			EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = work.id AND location.location_type IN ('remote_stream', 'remote_download') AND location.availability = 'available'
			) AS has_remote,
			EXISTS (
				SELECT 1 FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE item.work_id = work.id AND location.location_type = 'cache' AND location.availability = 'available'
			) AS has_cache
		FROM work_credit AS credit
		INNER JOIN work ON work.id = credit.work_id
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id
			AND user_work_state.user_id = ?
		WHERE credit.person_id = ?
			AND credit.role = 'voice_actor'
		ORDER BY COALESCE(work.release_date, '') DESC, work.primary_code DESC
	`, userID, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	works := []voiceKnownWork{}
	for rows.Next() {
		row, err := scanVoiceWorkRow(rows)
		if err != nil {
			return nil, err
		}
		metadata := parseDLsiteSnapshot(row.Snapshot)
		sourceTags, err := s.workSourceTagsByCode(ctx, row.PrimaryCode)
		if err != nil {
			return nil, err
		}
		if row.CircleLink.Valid {
			if name, externalID := parsePartyLink(row.CircleLink.String); name != "" {
				metadata.Circle = name
				metadata.CircleExternalID = externalID
			}
		}
		works = append(works, voiceKnownWork{
			WorkID:           row.ID,
			PrimaryCode:      row.PrimaryCode,
			Title:            row.Title,
			ReleaseDate:      nullableString(row.ReleaseDate),
			CoverURL:         s.coverURL(row.PrimaryCode),
			DLsiteURL:        dlsiteURL(row.PrimaryCode),
			Circle:           metadata.Circle,
			CircleExternalID: metadata.CircleExternalID,
			Rating:           metadata.Rating,
			Tags:             metadata.Tags,
			ListeningMark:    row.ListeningStatus,
			Local:            row.HasLocal,
			Remote:           row.HasRemote,
			Cache:            row.HasCache,
			SourceTags:       sourceTags,
		})
	}
	return works, rows.Err()
}

func (s *Server) searchVoiceRemoteSources(ctx context.Context, personID int64, voiceName string) ([]voiceRemoteSourceSet, error) {
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	results := []voiceRemoteSourceSet{}
	keyword := "$va:" + strings.TrimSpace(voiceName) + "$"
	for _, source := range sources {
		result := voiceRemoteSourceSet{
			SourceID:    source.ID,
			SourceCode:  source.Code,
			DisplayName: source.DisplayName,
			Status:      "ok",
			Works:       []voiceRemoteWork{},
		}
		if source.SourceType != "kikoeru_compatible" {
			result.Status = "unsupported"
			results = append(results, result)
			continue
		}
		if !source.Enabled {
			result.Status = "disabled"
			results = append(results, result)
			continue
		}
		if strings.TrimSpace(source.Endpoint.APIURL) == "" {
			result.Status = "error"
			result.Error = "source has no API endpoint"
			results = append(results, result)
			continue
		}
		started := time.Now()
		client := kikoeru.NewClient(source.Endpoint.APIURL, nil)
		page, err := client.ListWorks(ctx, 1, voiceRemotePageSize, keyword)
		result.ElapsedMS = time.Since(started).Milliseconds()
		if err != nil {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			result.Status = "error"
			result.Error = err.Error()
			results = append(results, result)
			continue
		}
		_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		result.Total = page.Pagination.Total
		if result.Total == 0 {
			result.Total = page.Pagination.Count
		}
		for _, remoteWork := range page.Works {
			code := normalizedRemoteWorkCode(remoteWork)
			flags, err := s.sourceAvailabilityFlags(ctx, source.ID, code)
			if err != nil {
				return nil, err
			}
			result.Works = append(result.Works, voiceRemoteWork{
				SourceID:       source.ID,
				SourceCode:     source.Code,
				SourceName:     source.DisplayName,
				RemoteID:       fmt.Sprintf("%d", remoteWork.ID),
				PrimaryCode:    code,
				Title:          firstNonEmpty(remoteWork.Title, remoteWork.Name, code),
				CoverURL:       firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL),
				Circle:         remoteCircleName(remoteWork),
				Rating:         remoteWork.RateAverage2DP,
				Tags:           remoteTagNames(remoteWork.Tags),
				ImportStatus:   remoteImportStatus(flags.WorkID),
				RemotePlayable: true,
				WorkID:         flags.WorkID,
				HasLocal:       flags.HasLocal,
				HasCache:       flags.HasCache,
				HasRemote:      flags.HasRemote,
			})
		}
		results = append(results, result)
	}
	_, err = s.recordVoiceRemoteSearchWorkflow(ctx, personID, voiceName, keyword, results)
	return results, err
}

func (s *Server) recordVoiceRemoteSearchWorkflow(ctx context.Context, personID int64, voiceName string, keyword string, results []voiceRemoteSourceSet) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "voice_remote_search", "Search voice remote sources", "Search configured Kikoeru-compatible sources for a voice actor.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "discover", "type": "discover_remote_works"},
			{"id": "match", "type": "match_works"},
		},
	})
	if err != nil {
		return 0, err
	}
	available := 0
	errorsCount := 0
	matches := 0
	for _, result := range results {
		if result.Status == "ok" {
			available++
		}
		if result.Status == "error" {
			errorsCount++
		}
		matches += len(result.Works)
	}
	input := map[string]any{"person_id": personID, "voice_name": voiceName, "keyword": keyword}
	summary := map[string]any{"sources": len(results), "ok": available, "errors": errorsCount, "matches": matches}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "voice_remote_search", "Search voice remote sources", "succeeded", "detail_view", "voice_detail_remote_matches", input, summary)
	if err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote sources", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"sources": len(results)},
	}); err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Discover voice matches", Position: 2, Status: "succeeded",
		Input: map[string]any{"keyword": keyword}, Output: summary,
	}); err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "match", NodeType: "match_works", DisplayName: "Match local and cached availability", Position: 3, Status: "succeeded",
		Input: map[string]any{"person_id": personID}, Output: voiceRemoteSearchOutput(results),
	}); err != nil {
		return 0, err
	}
	return runID, tx.Commit()
}

func voiceRemoteSearchOutput(results []voiceRemoteSourceSet) map[string]any {
	output := map[string]any{}
	for _, result := range results {
		output[result.SourceCode] = map[string]any{
			"status":  result.Status,
			"total":   result.Total,
			"matches": len(result.Works),
			"error":   result.Error,
		}
	}
	return output
}

func (s *Server) syncVoiceCreditsFromSnapshots(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id, snapshot.provider_id, snapshot.snapshot_json
		FROM work
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.work_id = work.id
		ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
	`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type snapshotRow struct {
		WorkID     int64
		ProviderID sql.NullInt64
		Raw        string
	}
	snapshots := []snapshotRow{}
	seen := map[int64]bool{}
	for rows.Next() {
		var item snapshotRow
		if err := rows.Scan(&item.WorkID, &item.ProviderID, &item.Raw); err != nil {
			return err
		}
		if seen[item.WorkID] {
			continue
		}
		seen[item.WorkID] = true
		snapshots = append(snapshots, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, snapshot := range snapshots {
		metadata := parseDLsiteSnapshot(snapshot.Raw)
		actors := metadata.VoiceActors
		if len(actors) == 0 {
			actors = parseKikoeruVoiceActors(snapshot.Raw)
		}
		seenActor := map[string]bool{}
		for _, actor := range actors {
			name := strings.TrimSpace(actor)
			if name == "" || seenActor[voiceNameKey(name)] {
				continue
			}
			seenActor[voiceNameKey(name)] = true
			personID, err := upsertPerson(ctx, tx, name)
			if err != nil {
				return err
			}
			var provider any
			if snapshot.ProviderID.Valid {
				provider = snapshot.ProviderID.Int64
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO work_credit (work_id, person_id, role, provider_id, source, updated_at)
				VALUES (?, ?, 'voice_actor', ?, 'metadata_snapshot', CURRENT_TIMESTAMP)
				ON CONFLICT(work_id, person_id, role) DO UPDATE SET
					provider_id = excluded.provider_id,
					source = excluded.source,
					updated_at = CURRENT_TIMESTAMP
			`, snapshot.WorkID, personID, provider); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func upsertPerson(ctx context.Context, tx *sql.Tx, name string) (int64, error) {
	name = strings.TrimSpace(name)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person (display_name, sort_name)
		VALUES (?, ?)
		ON CONFLICT(display_name) DO UPDATE SET
			updated_at = CURRENT_TIMESTAMP
	`, name, strings.ToLower(name)); err != nil {
		return 0, err
	}
	var id int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM person WHERE display_name = ?", name).Scan(&id); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, ?, 'primary_name')
		ON CONFLICT(person_id, alias) DO NOTHING
	`, id, name); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *Server) ensureVoiceSchema(ctx context.Context) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS person (
			id INTEGER PRIMARY KEY,
			display_name TEXT NOT NULL,
			sort_name TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(display_name)
		)`,
		`CREATE TABLE IF NOT EXISTS person_alias (
			id INTEGER PRIMARY KEY,
			person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
			alias TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(person_id, alias)
		)`,
		`CREATE TABLE IF NOT EXISTS work_credit (
			work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
			person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
			role TEXT NOT NULL,
			provider_id INTEGER REFERENCES metadata_provider(id),
			source TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(work_id, person_id, role)
		)`,
		`CREATE TABLE IF NOT EXISTS user_person_state (
			user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
			person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
			rating INTEGER,
			note TEXT NOT NULL DEFAULT '',
			favorite INTEGER NOT NULL DEFAULT 0,
			last_viewed_at TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(user_id, person_id)
		)`,
		`CREATE TABLE IF NOT EXISTS user_person_tag (
			id INTEGER PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			color TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			UNIQUE(user_id, name)
		)`,
		`CREATE TABLE IF NOT EXISTS user_person_tag_assignment (
			user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
			person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
			user_person_tag_id INTEGER NOT NULL REFERENCES user_person_tag(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(user_id, person_id, user_person_tag_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_work_credit_person ON work_credit(person_id, role)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) loadPersonName(ctx context.Context, personID int64) (string, error) {
	var name string
	err := s.db.QueryRowContext(ctx, "SELECT display_name FROM person WHERE id = ?", personID).Scan(&name)
	return name, err
}

func (s *Server) replaceVoiceUserTags(ctx context.Context, userID int64, personID int64, rawTags []string) ([]voiceUserTag, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_tag_assignment WHERE user_id = ? AND person_id = ?", userID, personID); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, raw := range rawTags {
		name := strings.TrimSpace(raw)
		if name == "" || seen[strings.ToLower(name)] {
			continue
		}
		seen[strings.ToLower(name)] = true
		if len(name) > 40 {
			name = name[:40]
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_person_tag (user_id, name)
			VALUES (?, ?)
			ON CONFLICT(user_id, name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
		`, userID, name); err != nil {
			return nil, err
		}
		tagID, err := selectID(ctx, tx, "SELECT id FROM user_person_tag WHERE user_id = ? AND name = ?", userID, name)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_person_tag_assignment (user_id, person_id, user_person_tag_id)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, person_id, user_person_tag_id) DO NOTHING
		`, userID, personID, tagID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.loadVoiceUserTags(ctx, userID, personID)
}

func (s *Server) loadVoiceUserTags(ctx context.Context, userID int64, personID int64) ([]voiceUserTag, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT tag.id, tag.name, tag.color
		FROM user_person_tag_assignment AS assignment
		INNER JOIN user_person_tag AS tag ON tag.id = assignment.user_person_tag_id
		WHERE assignment.user_id = ?
			AND assignment.person_id = ?
		ORDER BY tag.name ASC
	`, userID, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []voiceUserTag{}
	for rows.Next() {
		var tag voiceUserTag
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}

func (s *Server) workSourceTagsByCode(ctx context.Context, code string) ([]circleSourceStat, error) {
	var workID int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return []circleSourceStat{}, nil
		}
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, location.location_type, COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE item.work_id = ?
			AND location.availability = 'available'
		GROUP BY source.id, source.display_name, location.location_type
		ORDER BY source.priority ASC, source.display_name ASC
	`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []circleSourceStat{}
	seenRemote := false
	for rows.Next() {
		var sourceID int64
		var name, locationType string
		var count int
		if err := rows.Scan(&sourceID, &name, &locationType, &count); err != nil {
			return nil, err
		}
		switch locationType {
		case "local":
			tags = append(tags, circleSourceStat{Key: "local", DisplayName: "Local", Status: "available", Count: count})
		case "cache":
			tags = append(tags, circleSourceStat{Key: "cache", SourceID: &sourceID, DisplayName: "Cache", Status: "available", Count: count})
		case "remote_stream", "remote_download":
			seenRemote = true
			tags = append(tags, circleSourceStat{Key: fmt.Sprintf("source:%d", sourceID), SourceID: &sourceID, DisplayName: name, Status: "available", Count: count})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if seenRemote {
		tags = append([]circleSourceStat{{Key: "remote", DisplayName: "Remote", Status: "available", Count: 1}}, tags...)
	}
	return tags, nil
}

type voiceWorkRow struct {
	ID              int64
	PrimaryCode     string
	Title           string
	ReleaseDate     sql.NullString
	Snapshot        string
	CircleLink      sql.NullString
	ListeningStatus string
	HasLocal        bool
	HasRemote       bool
	HasCache        bool
}

func scanVoiceWorkRow(rows *sql.Rows) (voiceWorkRow, error) {
	var item voiceWorkRow
	var hasLocal, hasRemote, hasCache int
	err := rows.Scan(&item.ID, &item.PrimaryCode, &item.Title, &item.ReleaseDate, &item.Snapshot, &item.CircleLink, &item.ListeningStatus, &hasLocal, &hasRemote, &hasCache)
	item.HasLocal = hasLocal != 0
	item.HasRemote = hasRemote != 0
	item.HasCache = hasCache != 0
	return item, err
}

func parseKikoeruVoiceActors(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	var payload struct {
		VAs []struct {
			Name string `json:"name"`
		} `json:"vas"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return []string{}
	}
	seen := map[string]bool{}
	names := []string{}
	for _, va := range payload.VAs {
		name := strings.TrimSpace(va.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

func splitAliases(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	parts := strings.Split(raw, "\x1f")
	aliases := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			aliases = append(aliases, part)
		}
	}
	return aliases
}

func voiceNameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func countUnionInts(values ...int) int {
	total := 0
	for _, value := range values {
		total += value
	}
	return total
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func voiceSourceSummaries(local int, remote int, cache int) []circleSourceStat {
	items := []circleSourceStat{}
	if local > 0 {
		items = append(items, circleSourceStat{Key: "local", DisplayName: "Local", Status: "available", Count: local})
	}
	if cache > 0 {
		items = append(items, circleSourceStat{Key: "cache", DisplayName: "Cache", Status: "available", Count: cache})
	}
	if remote > 0 {
		items = append(items, circleSourceStat{Key: "remote", DisplayName: "Remote", Status: "available", Count: remote})
	}
	return items
}

func remoteCircleName(work kikoeru.Work) string {
	if work.Circle == nil {
		return ""
	}
	return strings.TrimSpace(work.Circle.Name)
}

func remoteTagNames(tags []kikoeru.Tag) []string {
	names := []string{}
	for _, tag := range tags {
		name := strings.TrimSpace(tag.Name)
		if name != "" {
			names = append(names, name)
		}
		if len(names) >= 8 {
			break
		}
	}
	return names
}

func remoteImportStatus(workID *int64) string {
	if workID == nil {
		return "remote"
	}
	return "imported"
}

func parseInt64Text(value string) int64 {
	id, _ := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	return id
}
