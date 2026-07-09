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
const voiceRemoteSourceTimeout = 5 * time.Second
const unknownVoiceActorName = "unknown"

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

type voiceAlias struct {
	ID        int64  `json:"id"`
	Alias     string `json:"alias"`
	Source    string `json:"source"`
	CreatedAt string `json:"createdAt"`
}

type voiceAliasCandidate struct {
	PersonID    int64        `json:"personId"`
	DisplayName string       `json:"displayName"`
	Aliases     []voiceAlias `json:"aliases"`
	KnownWorks  int          `json:"knownWorks"`
	LocalWorks  int          `json:"localWorks"`
	RemoteWorks int          `json:"remoteWorks"`
}

type voiceMergeReview struct {
	ID             int64  `json:"id"`
	TargetPersonID int64  `json:"targetPersonId"`
	SourcePersonID int64  `json:"sourcePersonId"`
	TargetName     string `json:"targetName"`
	SourceName     string `json:"sourceName"`
	Status         string `json:"status"`
	CreatedAt      string `json:"createdAt"`
	UndoneAt       string `json:"undoneAt"`
}

type personMergeSnapshot struct {
	SourcePerson   personSnapshot              `json:"sourcePerson"`
	Aliases        []personAliasSnapshot       `json:"aliases"`
	Credits        []workCreditSnapshot        `json:"credits"`
	States         []userPersonStateSnapshot   `json:"states"`
	TagLinks       []userPersonTagLinkSnapshot `json:"tagLinks"`
	TargetCredits  []workCreditSnapshot        `json:"targetCredits"`
	TargetStates   []userPersonStateSnapshot   `json:"targetStates"`
	TargetTagLinks []userPersonTagLinkSnapshot `json:"targetTagLinks"`
	AddedAliases   []string                    `json:"addedAliases"`
}

type personSnapshot struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"displayName"`
	SortName    string `json:"sortName"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type personAliasSnapshot struct {
	Alias     string `json:"alias"`
	Source    string `json:"source"`
	CreatedAt string `json:"createdAt"`
}

type workCreditSnapshot struct {
	WorkID     int64  `json:"workId"`
	Role       string `json:"role"`
	ProviderID *int64 `json:"providerId"`
	Source     string `json:"source"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

type userPersonStateSnapshot struct {
	UserID       int64   `json:"userId"`
	Rating       *int    `json:"rating"`
	Note         string  `json:"note"`
	Favorite     bool    `json:"favorite"`
	LastViewedAt *string `json:"lastViewedAt"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

type userPersonTagLinkSnapshot struct {
	UserID          int64  `json:"userId"`
	UserPersonTagID int64  `json:"userPersonTagId"`
	CreatedAt       string `json:"createdAt"`
}

type voiceDetail struct {
	voiceSummary
	Works         []voiceKnownWork       `json:"works"`
	RemoteMatches []voiceRemoteSourceSet `json:"remoteMatches"`
}

type voiceKnownWork struct {
	WorkID           int64               `json:"workId"`
	PrimaryCode      string              `json:"primaryCode"`
	Title            string              `json:"title"`
	ReleaseDate      *string             `json:"releaseDate"`
	UpdatedAt        string              `json:"updatedAt"`
	CoverURL         string              `json:"coverUrl"`
	DLsiteURL        string              `json:"dlsiteUrl"`
	Circle           string              `json:"circle"`
	CircleExternalID string              `json:"circleExternalId"`
	Rating           *float64            `json:"rating"`
	Sales            *int64              `json:"sales"`
	Tags             []string            `json:"tags"`
	Series           string              `json:"series"`
	SeriesTitleID    string              `json:"seriesTitleId"`
	ListeningMark    string              `json:"listeningMark"`
	Favorite         bool                `json:"favorite"`
	Local            bool                `json:"local"`
	Remote           bool                `json:"remote"`
	Cache            bool                `json:"cache"`
	SourceTags       []circleSourceStat  `json:"sourceTags"`
	Progress         workProgressSummary `json:"progress"`
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
	ReleaseDate    string   `json:"releaseDate"`
	UpdatedAt      string   `json:"updatedAt"`
	CoverURL       string   `json:"coverUrl"`
	Circle         string   `json:"circle"`
	Rating         *float64 `json:"rating"`
	Sales          *int64   `json:"sales"`
	Tags           []string `json:"tags"`
	ImportStatus   string   `json:"importStatus"`
	RemotePlayable bool     `json:"remotePlayable"`
	WorkID         *int64   `json:"workId"`
	HasLocal       bool     `json:"hasLocal"`
	HasCache       bool     `json:"hasCache"`
	HasRemote      bool     `json:"hasRemote"`
}

func (s *Server) listVoices(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	summaries, err := s.loadVoiceSummaries(r.Context(), userID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summaries)
}

func (s *Server) getVoice(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	summary, err := s.loadVoiceSummary(r.Context(), userID, personID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	works, err := s.loadVoiceKnownWorks(r.Context(), userID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	aliases, err := s.loadVoiceAliases(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	summary.Aliases = aliasNames(aliases)
	writeJSON(w, http.StatusOK, struct {
		voiceDetail
		AliasRecords []voiceAlias `json:"aliasRecords"`
	}{voiceDetail: voiceDetail{voiceSummary: summary, Works: works, RemoteMatches: []voiceRemoteSourceSet{}}, AliasRecords: aliases})
}

func (s *Server) getVoiceRemoteMatches(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	summary, err := s.loadVoiceSummary(r.Context(), userID, personID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	matches, err := s.searchVoiceRemoteSources(r.Context(), summary.PersonID, summary.DisplayName)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"personId": personID, "remoteMatches": matches})
}

func (s *Server) listVoiceAliasCandidates(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
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
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	candidates, err := s.loadVoiceAliasCandidates(r.Context(), personID, query)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, candidates)
}

func (s *Server) createVoiceAlias(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	var payload struct {
		Alias string `json:"alias"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	alias := strings.TrimSpace(payload.Alias)
	if alias == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "alias is required"})
		return
	}
	if len(alias) > 120 {
		alias = alias[:120]
	}
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, ?, 'manual_review')
		ON CONFLICT(person_id, alias) DO NOTHING
	`, personID, alias); err != nil {
		writeError(w, err)
		return
	}
	aliases, err := s.loadVoiceAliases(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, aliases)
}

func (s *Server) deleteVoiceAlias(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	aliasID, err := parseInt64PathValue(r, "aliasId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid alias id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM person_alias WHERE id = ? AND person_id = ? AND source <> 'primary_name'", aliasID, personID)
	if err != nil {
		writeError(w, err)
		return
	}
	deleted, _ := result.RowsAffected()
	aliases, err := s.loadVoiceAliases(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted, "aliases": aliases})
}

func (s *Server) mergeVoiceAliasCandidate(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	targetID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	var payload struct {
		SourcePersonID int64 `json:"sourcePersonId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if payload.SourcePersonID <= 0 || payload.SourcePersonID == targetID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source person must be different"})
		return
	}
	result, err := s.mergeVoicePeople(r.Context(), targetID, payload.SourcePersonID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) listVoiceMergeReviews(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	items, err := s.loadVoiceMergeReviews(r.Context(), personID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) undoVoiceMergeReview(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	personID, err := parseInt64PathValue(r, "personId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	mergeID, err := parseInt64PathValue(r, "mergeId")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid merge id"})
		return
	}
	result, err := s.undoVoiceMerge(r.Context(), personID, mergeID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "merge review not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) updateVoiceUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
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
	if _, err := s.loadPersonName(r.Context(), personID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	var currentRating sql.NullInt64
	currentNote := ""
	currentFavorite := 0
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT rating, COALESCE(note, ''), COALESCE(favorite, 0)
		FROM user_person_state
		WHERE user_id = ? AND person_id = ?
	`, user.ID, personID).Scan(&currentRating, &currentNote, &currentFavorite); err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeError(w, err)
		return
	}
	ratingValue := any(nil)
	if currentRating.Valid {
		ratingValue = int(currentRating.Int64)
	}
	if payload.Rating != nil {
		if *payload.Rating > 0 {
			ratingValue = *payload.Rating
		} else {
			ratingValue = nil
		}
	}
	note := currentNote
	if payload.Note != nil {
		note = strings.TrimSpace(*payload.Note)
	}
	favorite := currentFavorite
	if payload.Favorite != nil {
		favorite = 0
		if *payload.Favorite {
			favorite = 1
		}
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
			COALESCE(user_work_state.favorite, 0) AS favorite,
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
			) AS has_cache,
			COALESCE((
				SELECT series.title_id
				FROM party_series_work AS series_work
				INNER JOIN party_series AS series ON series.id = series_work.series_id
				WHERE UPPER(series_work.primary_code) = UPPER(work.primary_code)
				ORDER BY series.last_seen_at DESC, series.id DESC
				LIMIT 1
			), '') AS series_title_id
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
		progress, err := s.workProgressSummary(ctx, userID, row.ID)
		if err != nil {
			return nil, err
		}
		releaseDate := nullableString(row.ReleaseDate)
		updatedAt := ""
		if releaseDate != nil {
			updatedAt = *releaseDate
		}
		works = append(works, voiceKnownWork{
			WorkID:           row.ID,
			PrimaryCode:      row.PrimaryCode,
			Title:            row.Title,
			ReleaseDate:      releaseDate,
			UpdatedAt:        updatedAt,
			CoverURL:         s.coverURL(row.PrimaryCode),
			DLsiteURL:        dlsiteURL(row.PrimaryCode),
			Circle:           metadata.Circle,
			CircleExternalID: metadata.CircleExternalID,
			Rating:           metadata.Rating,
			Sales:            metadata.Sales,
			Tags:             metadata.Tags,
			Series:           metadata.Series,
			SeriesTitleID:    row.SeriesTitleID,
			ListeningMark:    row.ListeningStatus,
			Favorite:         row.Favorite,
			Local:            row.HasLocal,
			Remote:           row.HasRemote,
			Cache:            row.HasCache,
			SourceTags:       sourceTags,
			Progress:         progress,
		})
	}
	return works, rows.Err()
}

func (s *Server) searchVoiceRemoteSources(ctx context.Context, personID int64, voiceName string) ([]voiceRemoteSourceSet, error) {
	if isUnknownVoiceActorName(voiceName) {
		return []voiceRemoteSourceSet{}, nil
	}
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
		if !isKikoeruSourceType(source.SourceType) {
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
		sourceCtx, cancel := context.WithTimeout(ctx, voiceRemoteSourceTimeout)
		client := kikoeruClientForSource(source)
		page, err := client.ListWorks(sourceCtx, 1, voiceRemotePageSize, keyword)
		cancel()
		result.ElapsedMS = time.Since(started).Milliseconds()
		if err != nil {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			if errors.Is(err, context.DeadlineExceeded) || sourceCtx.Err() == context.DeadlineExceeded {
				result.Status = "timeout"
			} else {
				result.Status = "error"
			}
			result.Error = err.Error()
			results = append(results, result)
			continue
		}
		_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		result.Total = page.Pagination.TotalCount
		if result.Total == 0 {
			result.Total = page.Pagination.Total
		}
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
				ReleaseDate:    remoteWork.Release,
				UpdatedAt:      remoteWork.Release,
				CoverURL:       firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL),
				Circle:         remoteCircleName(remoteWork),
				Rating:         remoteWork.RateAverage2DP,
				Sales:          remoteWork.DLCount,
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

type voiceCreditSnapshotRow struct {
	WorkID     int64
	ProviderID sql.NullInt64
	Raw        string
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
	snapshots := []voiceCreditSnapshotRow{}
	seen := map[int64]bool{}
	for rows.Next() {
		var item voiceCreditSnapshotRow
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
		if err := syncVoiceCreditSnapshot(ctx, tx, snapshot); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) syncVoiceCreditsForWorkFromSnapshots(ctx context.Context, workID int64) error {
	var snapshot voiceCreditSnapshotRow
	if err := s.db.QueryRowContext(ctx, `
		SELECT work.id, snapshot.provider_id, snapshot.snapshot_json
		FROM work
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.work_id = work.id
		WHERE work.id = ?
		ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
		LIMIT 1
	`, workID).Scan(&snapshot.WorkID, &snapshot.ProviderID, &snapshot.Raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := syncVoiceCreditSnapshot(ctx, tx, snapshot); err != nil {
		return err
	}
	return tx.Commit()
}

func syncVoiceCreditSnapshot(ctx context.Context, tx *sql.Tx, snapshot voiceCreditSnapshotRow) error {
	metadata := parseDLsiteSnapshot(snapshot.Raw)
	actors := metadata.VoiceActors
	if len(actors) == 0 {
		actors = parseKikoeruVoiceActors(snapshot.Raw)
	}
	if len(actors) == 0 {
		actors = []string{unknownVoiceActorName}
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
	return nil
}

func isUnknownVoiceActorName(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), unknownVoiceActorName)
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

func (s *Server) loadPersonName(ctx context.Context, personID int64) (string, error) {
	var name string
	err := s.db.QueryRowContext(ctx, "SELECT display_name FROM person WHERE id = ?", personID).Scan(&name)
	return name, err
}

func (s *Server) loadVoiceAliases(ctx context.Context, personID int64) ([]voiceAlias, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, alias, source, created_at
		FROM person_alias
		WHERE person_id = ?
		ORDER BY CASE WHEN source = 'primary_name' THEN 0 ELSE 1 END, alias ASC
	`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	aliases := []voiceAlias{}
	for rows.Next() {
		var item voiceAlias
		if err := rows.Scan(&item.ID, &item.Alias, &item.Source, &item.CreatedAt); err != nil {
			return nil, err
		}
		aliases = append(aliases, item)
	}
	return aliases, rows.Err()
}

func (s *Server) loadVoiceAliasCandidates(ctx context.Context, personID int64, query string) ([]voiceAliasCandidate, error) {
	pattern := "%" + strings.ToLower(query) + "%"
	args := []any{personID}
	filter := ""
	if query != "" {
		filter = `AND (
			LOWER(person.display_name) LIKE ?
			OR EXISTS (
				SELECT 1 FROM person_alias AS candidate_alias
				WHERE candidate_alias.person_id = person.id
					AND LOWER(candidate_alias.alias) LIKE ?
			)
		)`
		args = append(args, pattern, pattern)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			person.id,
			person.display_name,
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
			) THEN credit.work_id END) AS remote_works
		FROM person
		LEFT JOIN work_credit AS credit ON credit.person_id = person.id AND credit.role = 'voice_actor'
		WHERE person.id <> ?
		`+filter+`
		GROUP BY person.id, person.display_name
		ORDER BY
			CASE WHEN ? = '' THEN 0 ELSE 1 END,
			known_works DESC,
			person.display_name ASC
		LIMIT 30
	`, append(args, query)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := []voiceAliasCandidate{}
	for rows.Next() {
		var item voiceAliasCandidate
		if err := rows.Scan(&item.PersonID, &item.DisplayName, &item.KnownWorks, &item.LocalWorks, &item.RemoteWorks); err != nil {
			return nil, err
		}
		aliases, err := s.loadVoiceAliases(ctx, item.PersonID)
		if err != nil {
			return nil, err
		}
		item.Aliases = aliases
		candidates = append(candidates, item)
	}
	return candidates, rows.Err()
}

func (s *Server) loadVoiceMergeReviews(ctx context.Context, personID int64) ([]voiceMergeReview, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, target_person_id, source_person_id, target_name, source_name, status, created_at, COALESCE(undone_at, '')
		FROM person_merge_review
		WHERE target_person_id = ?
		ORDER BY created_at DESC, id DESC
		LIMIT 20
	`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []voiceMergeReview{}
	for rows.Next() {
		var item voiceMergeReview
		if err := rows.Scan(&item.ID, &item.TargetPersonID, &item.SourcePersonID, &item.TargetName, &item.SourceName, &item.Status, &item.CreatedAt, &item.UndoneAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Server) mergeVoicePeople(ctx context.Context, targetID int64, sourceID int64) (map[string]any, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var targetName, sourceName string
	if err := tx.QueryRowContext(ctx, "SELECT display_name FROM person WHERE id = ?", targetID).Scan(&targetName); err != nil {
		return nil, err
	}
	if err := tx.QueryRowContext(ctx, "SELECT display_name FROM person WHERE id = ?", sourceID).Scan(&sourceName); err != nil {
		return nil, err
	}
	snapshot, err := loadPersonMergeSnapshot(ctx, tx, targetID, sourceID)
	if err != nil {
		return nil, err
	}
	addedAliasSet := map[string]bool{}
	addedAliasSet[sourceName] = true
	for _, alias := range snapshot.Aliases {
		addedAliasSet[alias.Alias] = true
	}
	for alias := range addedAliasSet {
		snapshot.AddedAliases = append(snapshot.AddedAliases, alias)
	}
	snapshotJSON, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	mergeReviewID, err := insertPersonMergeReview(ctx, tx, targetID, sourceID, targetName, sourceName, string(snapshotJSON))
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, ?, 'merged_name')
		ON CONFLICT(person_id, alias) DO NOTHING
	`, targetID, sourceName); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person_alias (person_id, alias, source)
		SELECT ?, alias, CASE WHEN source = 'primary_name' THEN 'merged_primary_name' ELSE 'merged_alias' END
		FROM person_alias
		WHERE person_id = ?
		ON CONFLICT(person_id, alias) DO NOTHING
	`, targetID, sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_credit (work_id, person_id, role, provider_id, source, created_at, updated_at)
		SELECT work_id, ?, role, provider_id, source, created_at, CURRENT_TIMESTAMP
		FROM work_credit
		WHERE person_id = ?
		ON CONFLICT(work_id, person_id, role) DO UPDATE SET
			provider_id = COALESCE(excluded.provider_id, work_credit.provider_id),
			source = CASE WHEN work_credit.source = '' THEN excluded.source ELSE work_credit.source END,
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_person_state (user_id, person_id, rating, note, favorite, last_viewed_at, created_at, updated_at)
		SELECT user_id, ?, rating, note, favorite, last_viewed_at, created_at, CURRENT_TIMESTAMP
		FROM user_person_state
		WHERE person_id = ?
		ON CONFLICT(user_id, person_id) DO UPDATE SET
			rating = COALESCE(user_person_state.rating, excluded.rating),
			note = CASE WHEN user_person_state.note = '' THEN excluded.note ELSE user_person_state.note END,
			favorite = CASE WHEN excluded.favorite = 1 THEN 1 ELSE user_person_state.favorite END,
			last_viewed_at = COALESCE(user_person_state.last_viewed_at, excluded.last_viewed_at),
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_person_tag_assignment (user_id, person_id, user_person_tag_id, created_at)
		SELECT user_id, ?, user_person_tag_id, created_at
		FROM user_person_tag_assignment
		WHERE person_id = ?
		ON CONFLICT(user_id, person_id, user_person_tag_id) DO NOTHING
	`, targetID, sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_credit WHERE person_id = ?", sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_state WHERE person_id = ?", sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_tag_assignment WHERE person_id = ?", sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM person_alias WHERE person_id = ?", sourceID); err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM person WHERE id = ?", sourceID)
	if err != nil {
		return nil, err
	}
	deleted, _ := result.RowsAffected()
	if deleted == 0 {
		return nil, sql.ErrNoRows
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"mergeId": mergeReviewID, "targetPersonId": targetID, "sourcePersonId": sourceID, "targetName": targetName, "mergedName": sourceName}, nil
}

func (s *Server) undoVoiceMerge(ctx context.Context, targetID int64, mergeID int64) (map[string]any, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var snapshotRaw string
	var status string
	var sourceName string
	err = tx.QueryRowContext(ctx, `
		SELECT snapshot_json, status, source_name
		FROM person_merge_review
		WHERE id = ? AND target_person_id = ?
	`, mergeID, targetID).Scan(&snapshotRaw, &status, &sourceName)
	if err != nil {
		return nil, err
	}
	if status != "merged" {
		return nil, fmt.Errorf("merge review is already %s", status)
	}
	var snapshot personMergeSnapshot
	if err := json.Unmarshal([]byte(snapshotRaw), &snapshot); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO person (id, display_name, sort_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			display_name = excluded.display_name,
			sort_name = excluded.sort_name,
			updated_at = CURRENT_TIMESTAMP
	`, snapshot.SourcePerson.ID, snapshot.SourcePerson.DisplayName, snapshot.SourcePerson.SortName, snapshot.SourcePerson.CreatedAt, snapshot.SourcePerson.UpdatedAt); err != nil {
		return nil, err
	}
	for _, alias := range snapshot.Aliases {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO person_alias (person_id, alias, source, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(person_id, alias) DO NOTHING
		`, snapshot.SourcePerson.ID, alias.Alias, alias.Source, alias.CreatedAt); err != nil {
			return nil, err
		}
	}
	for _, credit := range snapshot.Credits {
		var provider any
		if credit.ProviderID != nil {
			provider = *credit.ProviderID
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_credit (work_id, person_id, role, provider_id, source, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(work_id, person_id, role) DO UPDATE SET
				provider_id = excluded.provider_id,
				source = excluded.source,
				updated_at = CURRENT_TIMESTAMP
		`, credit.WorkID, snapshot.SourcePerson.ID, credit.Role, provider, credit.Source, credit.CreatedAt, credit.UpdatedAt); err != nil {
			return nil, err
		}
	}
	targetCreditKeys := map[string]bool{}
	for _, credit := range snapshot.TargetCredits {
		targetCreditKeys[workCreditKey(credit.WorkID, credit.Role)] = true
	}
	for _, credit := range snapshot.Credits {
		if targetCreditKeys[workCreditKey(credit.WorkID, credit.Role)] {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM work_credit WHERE work_id = ? AND person_id = ? AND role = ?", credit.WorkID, targetID, credit.Role); err != nil {
			return nil, err
		}
	}
	for _, state := range snapshot.States {
		var rating any
		if state.Rating != nil {
			rating = *state.Rating
		}
		var lastViewed any
		if state.LastViewedAt != nil {
			lastViewed = *state.LastViewedAt
		}
		favorite := 0
		if state.Favorite {
			favorite = 1
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_person_state (user_id, person_id, rating, note, favorite, last_viewed_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(user_id, person_id) DO UPDATE SET
				rating = excluded.rating,
				note = excluded.note,
				favorite = excluded.favorite,
				last_viewed_at = excluded.last_viewed_at,
				updated_at = CURRENT_TIMESTAMP
		`, state.UserID, snapshot.SourcePerson.ID, rating, state.Note, favorite, lastViewed, state.CreatedAt, state.UpdatedAt); err != nil {
			return nil, err
		}
	}
	targetStateUsers := map[int64]bool{}
	for _, state := range snapshot.TargetStates {
		targetStateUsers[state.UserID] = true
		if err := restoreUserPersonState(ctx, tx, targetID, state); err != nil {
			return nil, err
		}
	}
	for _, state := range snapshot.States {
		if targetStateUsers[state.UserID] {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_state WHERE user_id = ? AND person_id = ?", state.UserID, targetID); err != nil {
			return nil, err
		}
	}
	for _, link := range snapshot.TagLinks {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_person_tag_assignment (user_id, person_id, user_person_tag_id, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(user_id, person_id, user_person_tag_id) DO NOTHING
		`, link.UserID, snapshot.SourcePerson.ID, link.UserPersonTagID, link.CreatedAt); err != nil {
			return nil, err
		}
	}
	targetTagKeys := map[string]bool{}
	for _, link := range snapshot.TargetTagLinks {
		targetTagKeys[userTagLinkKey(link.UserID, link.UserPersonTagID)] = true
	}
	for _, link := range snapshot.TagLinks {
		if targetTagKeys[userTagLinkKey(link.UserID, link.UserPersonTagID)] {
			continue
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_tag_assignment WHERE user_id = ? AND person_id = ? AND user_person_tag_id = ?", link.UserID, targetID, link.UserPersonTagID); err != nil {
			return nil, err
		}
	}
	for _, alias := range snapshot.AddedAliases {
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM person_alias
			WHERE person_id = ?
				AND alias = ?
				AND source IN ('merged_name', 'merged_primary_name', 'merged_alias')
		`, targetID, alias); err != nil {
			return nil, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE person_merge_review
		SET status = 'undone',
			undone_at = CURRENT_TIMESTAMP
		WHERE id = ? AND target_person_id = ? AND status = 'merged'
	`, mergeID, targetID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"mergeId": mergeID, "targetPersonId": targetID, "restoredPersonId": snapshot.SourcePerson.ID, "restoredName": sourceName}, nil
}

func insertPersonMergeReview(ctx context.Context, tx *sql.Tx, targetID int64, sourceID int64, targetName string, sourceName string, snapshotJSON string) (int64, error) {
	result, err := tx.ExecContext(ctx, `
		INSERT INTO person_merge_review (target_person_id, source_person_id, target_name, source_name, snapshot_json)
		VALUES (?, ?, ?, ?, ?)
	`, targetID, sourceID, targetName, sourceName, snapshotJSON)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func loadPersonMergeSnapshot(ctx context.Context, tx *sql.Tx, targetID int64, personID int64) (personMergeSnapshot, error) {
	var snapshot personMergeSnapshot
	if err := tx.QueryRowContext(ctx, `
		SELECT id, display_name, sort_name, created_at, updated_at
		FROM person
		WHERE id = ?
	`, personID).Scan(&snapshot.SourcePerson.ID, &snapshot.SourcePerson.DisplayName, &snapshot.SourcePerson.SortName, &snapshot.SourcePerson.CreatedAt, &snapshot.SourcePerson.UpdatedAt); err != nil {
		return snapshot, err
	}
	aliases, err := tx.QueryContext(ctx, "SELECT alias, source, created_at FROM person_alias WHERE person_id = ? ORDER BY id ASC", personID)
	if err != nil {
		return snapshot, err
	}
	for aliases.Next() {
		var item personAliasSnapshot
		if err := aliases.Scan(&item.Alias, &item.Source, &item.CreatedAt); err != nil {
			_ = aliases.Close()
			return snapshot, err
		}
		snapshot.Aliases = append(snapshot.Aliases, item)
	}
	if err := aliases.Close(); err != nil {
		return snapshot, err
	}
	credits, err := tx.QueryContext(ctx, "SELECT work_id, role, provider_id, source, created_at, updated_at FROM work_credit WHERE person_id = ? ORDER BY work_id ASC", personID)
	if err != nil {
		return snapshot, err
	}
	for credits.Next() {
		var item workCreditSnapshot
		var provider sql.NullInt64
		if err := credits.Scan(&item.WorkID, &item.Role, &provider, &item.Source, &item.CreatedAt, &item.UpdatedAt); err != nil {
			_ = credits.Close()
			return snapshot, err
		}
		if provider.Valid {
			value := provider.Int64
			item.ProviderID = &value
		}
		snapshot.Credits = append(snapshot.Credits, item)
	}
	if err := credits.Close(); err != nil {
		return snapshot, err
	}
	states, err := tx.QueryContext(ctx, "SELECT user_id, rating, note, favorite, last_viewed_at, created_at, updated_at FROM user_person_state WHERE person_id = ? ORDER BY user_id ASC", personID)
	if err != nil {
		return snapshot, err
	}
	for states.Next() {
		var item userPersonStateSnapshot
		var rating sql.NullInt64
		var favorite int
		var lastViewed sql.NullString
		if err := states.Scan(&item.UserID, &rating, &item.Note, &favorite, &lastViewed, &item.CreatedAt, &item.UpdatedAt); err != nil {
			_ = states.Close()
			return snapshot, err
		}
		if rating.Valid {
			value := int(rating.Int64)
			item.Rating = &value
		}
		item.Favorite = favorite != 0
		if lastViewed.Valid {
			value := lastViewed.String
			item.LastViewedAt = &value
		}
		snapshot.States = append(snapshot.States, item)
	}
	if err := states.Close(); err != nil {
		return snapshot, err
	}
	links, err := tx.QueryContext(ctx, "SELECT user_id, user_person_tag_id, created_at FROM user_person_tag_assignment WHERE person_id = ? ORDER BY user_id ASC, user_person_tag_id ASC", personID)
	if err != nil {
		return snapshot, err
	}
	for links.Next() {
		var item userPersonTagLinkSnapshot
		if err := links.Scan(&item.UserID, &item.UserPersonTagID, &item.CreatedAt); err != nil {
			_ = links.Close()
			return snapshot, err
		}
		snapshot.TagLinks = append(snapshot.TagLinks, item)
	}
	if err := links.Close(); err != nil {
		return snapshot, err
	}
	targetCredits, err := loadWorkCreditSnapshots(ctx, tx, targetID)
	if err != nil {
		return snapshot, err
	}
	snapshot.TargetCredits = targetCredits
	targetStates, err := loadUserPersonStateSnapshots(ctx, tx, targetID)
	if err != nil {
		return snapshot, err
	}
	snapshot.TargetStates = targetStates
	targetLinks, err := loadUserPersonTagLinkSnapshots(ctx, tx, targetID)
	if err != nil {
		return snapshot, err
	}
	snapshot.TargetTagLinks = targetLinks
	return snapshot, nil
}

func loadWorkCreditSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]workCreditSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT work_id, role, provider_id, source, created_at, updated_at FROM work_credit WHERE person_id = ? ORDER BY work_id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []workCreditSnapshot{}
	for rows.Next() {
		var item workCreditSnapshot
		var provider sql.NullInt64
		if err := rows.Scan(&item.WorkID, &item.Role, &provider, &item.Source, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if provider.Valid {
			value := provider.Int64
			item.ProviderID = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadUserPersonStateSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]userPersonStateSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT user_id, rating, note, favorite, last_viewed_at, created_at, updated_at FROM user_person_state WHERE person_id = ? ORDER BY user_id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []userPersonStateSnapshot{}
	for rows.Next() {
		var item userPersonStateSnapshot
		var rating sql.NullInt64
		var favorite int
		var lastViewed sql.NullString
		if err := rows.Scan(&item.UserID, &rating, &item.Note, &favorite, &lastViewed, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		if rating.Valid {
			value := int(rating.Int64)
			item.Rating = &value
		}
		item.Favorite = favorite != 0
		if lastViewed.Valid {
			value := lastViewed.String
			item.LastViewedAt = &value
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func loadUserPersonTagLinkSnapshots(ctx context.Context, tx *sql.Tx, personID int64) ([]userPersonTagLinkSnapshot, error) {
	rows, err := tx.QueryContext(ctx, "SELECT user_id, user_person_tag_id, created_at FROM user_person_tag_assignment WHERE person_id = ? ORDER BY user_id ASC, user_person_tag_id ASC", personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []userPersonTagLinkSnapshot{}
	for rows.Next() {
		var item userPersonTagLinkSnapshot
		if err := rows.Scan(&item.UserID, &item.UserPersonTagID, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func restoreUserPersonState(ctx context.Context, tx *sql.Tx, personID int64, state userPersonStateSnapshot) error {
	var rating any
	if state.Rating != nil {
		rating = *state.Rating
	}
	var lastViewed any
	if state.LastViewedAt != nil {
		lastViewed = *state.LastViewedAt
	}
	favorite := 0
	if state.Favorite {
		favorite = 1
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO user_person_state (user_id, person_id, rating, note, favorite, last_viewed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, person_id) DO UPDATE SET
			rating = excluded.rating,
			note = excluded.note,
			favorite = excluded.favorite,
			last_viewed_at = excluded.last_viewed_at,
			updated_at = CURRENT_TIMESTAMP
	`, state.UserID, personID, rating, state.Note, favorite, lastViewed, state.CreatedAt, state.UpdatedAt)
	return err
}

func workCreditKey(workID int64, role string) string {
	return fmt.Sprintf("%d:%s", workID, role)
}

func userTagLinkKey(userID int64, tagID int64) string {
	return fmt.Sprintf("%d:%d", userID, tagID)
}

func aliasNames(aliases []voiceAlias) []string {
	names := []string{}
	for _, alias := range aliases {
		names = append(names, alias.Alias)
	}
	return names
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
	Favorite        bool
	HasLocal        bool
	HasRemote       bool
	HasCache        bool
	SeriesTitleID   string
}

func scanVoiceWorkRow(rows *sql.Rows) (voiceWorkRow, error) {
	var item voiceWorkRow
	var hasLocal, hasRemote, hasCache int
	var favorite int
	err := rows.Scan(&item.ID, &item.PrimaryCode, &item.Title, &item.ReleaseDate, &item.Snapshot, &item.CircleLink, &item.ListeningStatus, &favorite, &hasLocal, &hasRemote, &hasCache, &item.SeriesTitleID)
	item.Favorite = favorite != 0
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
