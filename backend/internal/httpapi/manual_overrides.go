package httpapi

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type workManualOverrides struct {
	Title       *string                `json:"title,omitempty"`
	Circle      *manualOverrideEntity  `json:"circle,omitempty"`
	Series      *manualOverrideSeries  `json:"series,omitempty"`
	VoiceActors []manualOverridePerson `json:"voiceActors,omitempty"`
	Cover       *manualOverrideCover   `json:"cover,omitempty"`
}

type manualOverrideEntity struct {
	Name       string `json:"name"`
	ExternalID string `json:"externalId"`
}

type manualOverrideSeries struct {
	Name             string `json:"name"`
	TitleID          string `json:"titleId"`
	CircleExternalID string `json:"circleExternalId"`
}

type manualOverridePerson struct {
	Name     string `json:"name"`
	PersonID int64  `json:"personId"`
}

type manualOverrideCover struct {
	AssetPath    string `json:"assetPath"`
	OriginalPath string `json:"originalPath"`
	URL          string `json:"url"`
}

type manualOverrideRow struct {
	FieldName string
	ValueJSON string
	AssetPath string
}

type workCoverCandidate struct {
	LocationID int64  `json:"locationId"`
	FileName   string `json:"fileName"`
	Path       string `json:"path"`
	PreviewURL string `json:"previewUrl"`
	SizeBytes  *int64 `json:"sizeBytes"`
	Selected   bool   `json:"selected"`
}

type workManualOverridePayload struct {
	Title       *string                `json:"title"`
	Circle      *manualOverrideEntity  `json:"circle"`
	Series      *manualOverrideSeries  `json:"series"`
	VoiceActors []manualOverridePerson `json:"voiceActors"`
}

func (s *Server) getWorkManualOverrides(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.workIDExists(r.Context(), workID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	overrides, err := s.loadWorkManualOverrides(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overrides)
}

func (s *Server) updateWorkManualOverrides(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.workIDExists(r.Context(), workID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	var payload workManualOverridePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json body"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := upsertManualTextOverride(r.Context(), tx, workID, "title", payload.Title, user.ID); err != nil {
		writeError(w, err)
		return
	}
	if err := upsertManualJSONOverride(r.Context(), tx, workID, "circle", normalizeManualEntity(payload.Circle), user.ID); err != nil {
		writeError(w, err)
		return
	}
	if err := upsertManualJSONOverride(r.Context(), tx, workID, "series", normalizeManualSeries(payload.Series), user.ID); err != nil {
		writeError(w, err)
		return
	}
	actors := normalizeManualPeople(payload.VoiceActors)
	var actorValue any
	if len(actors) > 0 {
		actorValue = actors
	}
	if err := upsertManualJSONOverride(r.Context(), tx, workID, "voice_actors", actorValue, user.ID); err != nil {
		writeError(w, err)
		return
	}
	if err := syncManualOverrideRelations(r.Context(), tx, workID, normalizeManualEntity(payload.Circle), normalizeManualSeries(payload.Series), actors); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	overrides, err := s.loadWorkManualOverrides(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overrides)
}

func (s *Server) deleteWorkManualOverride(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	field := normalizeManualOverrideField(r.PathValue("field"))
	if field == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid override field"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(r.Context(), "DELETE FROM work_manual_override WHERE work_id = ? AND field_name = ?", workID, field)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := deleteManualOverrideRelations(r.Context(), tx, workID, field); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	deleted, _ := result.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func (s *Server) listWorkCoverCandidates(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if err := s.ensureLocalMediaIndexed(r.Context(), workID); err != nil {
		writeError(w, err)
		return
	}
	candidates, err := s.workCoverCandidates(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"candidates": candidates})
}

func (s *Server) setWorkCoverOverride(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	var payload struct {
		LocationID int64 `json:"locationId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json body"})
		return
	}
	assetPath, originalPath, err := s.copyManualCoverFromLocation(r.Context(), workID, payload.LocationID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	valueJSON := mustJSON(map[string]string{"source": "local_file", "originalPath": originalPath})
	_, err = s.db.ExecContext(r.Context(), `
		INSERT INTO work_manual_override (work_id, field_name, value_json, asset_path, updated_by_user_id, created_at, updated_at)
		VALUES (?, 'cover', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, field_name) DO UPDATE SET
			value_json = excluded.value_json,
			asset_path = excluded.asset_path,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = CURRENT_TIMESTAMP
	`, workID, valueJSON, assetPath, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	overrides, err := s.loadWorkManualOverrides(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, overrides)
}

func (s *Server) workIDExists(ctx context.Context, workID int64) bool {
	var exists int
	_ = s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM work WHERE id = ?)", workID).Scan(&exists)
	return exists != 0
}

func (s *Server) loadWorkManualOverrides(ctx context.Context, workID int64) (workManualOverrides, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT field_name, value_json, asset_path
		FROM work_manual_override
		WHERE work_id = ?
	`, workID)
	if err != nil {
		return workManualOverrides{}, err
	}
	defer rows.Close()
	overrides := workManualOverrides{}
	for rows.Next() {
		var row manualOverrideRow
		if err := rows.Scan(&row.FieldName, &row.ValueJSON, &row.AssetPath); err != nil {
			return workManualOverrides{}, err
		}
		s.applyManualOverrideRow(&overrides, row)
	}
	return overrides, rows.Err()
}

func (s *Server) applyManualOverrideRow(overrides *workManualOverrides, row manualOverrideRow) {
	switch row.FieldName {
	case "title":
		var value string
		if err := json.Unmarshal([]byte(row.ValueJSON), &value); err == nil && strings.TrimSpace(value) != "" {
			value = strings.TrimSpace(value)
			overrides.Title = &value
		}
	case "circle":
		var value manualOverrideEntity
		if err := json.Unmarshal([]byte(row.ValueJSON), &value); err == nil {
			if entity := normalizeManualEntity(&value); entity != nil {
				overrides.Circle = entity
			}
		}
	case "series":
		var value manualOverrideSeries
		if err := json.Unmarshal([]byte(row.ValueJSON), &value); err == nil {
			if series := normalizeManualSeries(&value); series != nil {
				overrides.Series = series
			}
		}
	case "voice_actors":
		var value []manualOverridePerson
		if err := json.Unmarshal([]byte(row.ValueJSON), &value); err == nil {
			overrides.VoiceActors = normalizeManualPeople(value)
		}
	case "cover":
		if cover := s.manualCoverOverride(row.AssetPath, row.ValueJSON); cover != nil {
			overrides.Cover = cover
		}
	}
}

func applyManualOverridesToLibrarySummary(work *libraryWorkSummary, overrides workManualOverrides) {
	if overrides.Title != nil {
		work.Title = *overrides.Title
	}
	if overrides.Circle != nil {
		work.Circle = overrides.Circle.Name
		work.CircleExternalID = overrides.Circle.ExternalID
	}
	if overrides.Series != nil {
		work.Series = overrides.Series.Name
		work.SeriesTitleID = overrides.Series.TitleID
		if overrides.Series.CircleExternalID != "" {
			work.CircleExternalID = overrides.Series.CircleExternalID
		}
	}
	if len(overrides.VoiceActors) > 0 {
		work.VoiceActors = manualPeopleNames(overrides.VoiceActors)
	}
}

func (s *Server) applyManualOverridesToSummary(ctx context.Context, work *libraryWorkSummary) error {
	overrides, err := s.loadWorkManualOverrides(ctx, work.ID)
	if err != nil {
		return err
	}
	applyManualOverridesToLibrarySummary(work, overrides)
	return nil
}

func (s *Server) applyManualOverridesToDetail(ctx context.Context, work *workDetail) error {
	overrides, err := s.loadWorkManualOverrides(ctx, work.ID)
	if err != nil {
		return err
	}
	work.ManualOverrides = overrides
	if overrides.Title != nil {
		work.Title = *overrides.Title
	}
	if overrides.Circle != nil {
		work.Circle = overrides.Circle.Name
		work.CircleExternalID = overrides.Circle.ExternalID
	}
	if overrides.Series != nil {
		work.Series = overrides.Series.Name
		work.SeriesTitleID = overrides.Series.TitleID
		work.SeriesCircleID = overrides.Series.CircleExternalID
		if overrides.Series.CircleExternalID != "" && work.CircleExternalID == "" {
			work.CircleExternalID = overrides.Series.CircleExternalID
		}
	}
	if len(overrides.VoiceActors) > 0 {
		work.VoiceActors = manualPeopleNames(overrides.VoiceActors)
		work.VoiceCredits = manualPeopleCredits(overrides.VoiceActors)
	}
	return nil
}

func (s *Server) applyManualOverridesToCircleWork(ctx context.Context, work *circleCatalogWork) error {
	if work.WorkID == nil || *work.WorkID <= 0 {
		return nil
	}
	overrides, err := s.loadWorkManualOverrides(ctx, *work.WorkID)
	if err != nil {
		return err
	}
	if overrides.Title != nil {
		work.Title = *overrides.Title
	}
	if overrides.Circle != nil {
		work.Circle = overrides.Circle.Name
		work.CircleExternalID = overrides.Circle.ExternalID
	}
	if overrides.Series != nil {
		work.Series = overrides.Series.Name
		work.SeriesTitleID = overrides.Series.TitleID
		if overrides.Series.CircleExternalID != "" {
			work.CircleExternalID = overrides.Series.CircleExternalID
		}
	}
	return nil
}

func (s *Server) applyManualOverridesToVoiceWork(ctx context.Context, work *voiceKnownWork) error {
	if work.WorkID <= 0 {
		return nil
	}
	overrides, err := s.loadWorkManualOverrides(ctx, work.WorkID)
	if err != nil {
		return err
	}
	if overrides.Title != nil {
		work.Title = *overrides.Title
	}
	if overrides.Circle != nil {
		work.Circle = overrides.Circle.Name
		work.CircleExternalID = overrides.Circle.ExternalID
	}
	if overrides.Series != nil {
		work.Series = overrides.Series.Name
		work.SeriesTitleID = overrides.Series.TitleID
		if overrides.Series.CircleExternalID != "" {
			work.CircleExternalID = overrides.Series.CircleExternalID
		}
	}
	return nil
}

func (s *Server) manualCoverOverride(assetPath string, valueJSON string) *manualOverrideCover {
	assetPath = filepath.Base(filepath.FromSlash(strings.TrimSpace(assetPath)))
	if assetPath == "" || assetPath == "." || strings.Contains(assetPath, "..") {
		return nil
	}
	if _, err := os.Stat(filepath.Join(s.cfg.CacheRoot, "manual", assetPath)); err != nil {
		return nil
	}
	cover := &manualOverrideCover{
		AssetPath: assetPath,
		URL:       "/api/assets/manual/" + assetPath,
	}
	var value struct {
		OriginalPath string `json:"originalPath"`
	}
	if err := json.Unmarshal([]byte(valueJSON), &value); err == nil {
		cover.OriginalPath = filepath.ToSlash(strings.TrimSpace(value.OriginalPath))
	}
	return cover
}

func (s *Server) workCoverCandidates(ctx context.Context, workID int64) ([]workCoverCandidate, error) {
	overrides, err := s.loadWorkManualOverrides(ctx, workID)
	if err != nil {
		return nil, err
	}
	selectedPath := ""
	if overrides.Cover != nil {
		selectedPath = strings.ToUpper(filepath.ToSlash(overrides.Cover.OriginalPath))
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.path, location.size_bytes
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND item.kind = 'image'
			AND location.location_type = 'local'
			AND location.availability = 'available'
		ORDER BY item.track_no IS NULL, item.track_no, location.path
		LIMIT 120
	`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := []workCoverCandidate{}
	for rows.Next() {
		var candidate workCoverCandidate
		var size sql.NullInt64
		if err := rows.Scan(&candidate.LocationID, &candidate.Path, &size); err != nil {
			return nil, err
		}
		candidate.Path = filepath.ToSlash(candidate.Path)
		candidate.FileName = filepath.Base(candidate.Path)
		revision := sha1.Sum([]byte(fmt.Sprintf("%s:%d", candidate.Path, size.Int64)))
		candidate.PreviewURL = fmt.Sprintf("/api/media/%d/asset?v=%s", candidate.LocationID, hex.EncodeToString(revision[:])[:12])
		candidate.SizeBytes = nullableInt64(size)
		candidate.Selected = selectedPath != "" && strings.EqualFold(selectedPath, candidate.Path)
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

func (s *Server) copyManualCoverFromLocation(ctx context.Context, workID int64, locationID int64) (string, string, error) {
	if locationID <= 0 {
		return "", "", fmt.Errorf("invalid cover candidate")
	}
	var relPath string
	var kind string
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.path, item.kind
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
			AND item.work_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
	`, locationID, workID).Scan(&relPath, &kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("cover candidate not found")
		}
		return "", "", err
	}
	if kind != "image" || localFileKind(relPath) != "image" {
		return "", "", fmt.Errorf("cover candidate is not an image")
	}
	sourcePath, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		return "", "", fmt.Errorf("invalid cover candidate path")
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return "", "", err
	}
	defer source.Close()
	if err := os.MkdirAll(filepath.Join(s.cfg.CacheRoot, "manual"), 0o755); err != nil {
		return "", "", err
	}
	ext := strings.ToLower(filepath.Ext(relPath))
	if ext == "" {
		ext = ".jpg"
	}
	hash := sha1.Sum([]byte(fmt.Sprintf("%d:%d:%s", workID, locationID, filepath.ToSlash(relPath))))
	assetPath := fmt.Sprintf("work-%d-cover-%s%s", workID, hex.EncodeToString(hash[:])[:12], ext)
	targetPath, err := safeCachePath(filepath.Join(s.cfg.CacheRoot, "manual"), assetPath)
	if err != nil {
		return "", "", err
	}
	target, err := os.Create(targetPath)
	if err != nil {
		return "", "", err
	}
	defer target.Close()
	if _, err := io.Copy(target, source); err != nil {
		return "", "", err
	}
	return assetPath, filepath.ToSlash(relPath), nil
}

func upsertManualTextOverride(ctx context.Context, tx *sql.Tx, workID int64, field string, value *string, userID int64) error {
	if value == nil || strings.TrimSpace(*value) == "" {
		_, err := tx.ExecContext(ctx, "DELETE FROM work_manual_override WHERE work_id = ? AND field_name = ?", workID, field)
		return err
	}
	trimmed := strings.TrimSpace(*value)
	return upsertManualOverride(ctx, tx, workID, field, mustJSON(trimmed), "", userID)
}

func upsertManualJSONOverride(ctx context.Context, tx *sql.Tx, workID int64, field string, value any, userID int64) error {
	if value == nil {
		_, err := tx.ExecContext(ctx, "DELETE FROM work_manual_override WHERE work_id = ? AND field_name = ?", workID, field)
		return err
	}
	return upsertManualOverride(ctx, tx, workID, field, mustJSON(value), "", userID)
}

func upsertManualOverride(ctx context.Context, tx *sql.Tx, workID int64, field string, valueJSON string, assetPath string, userID int64) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO work_manual_override (work_id, field_name, value_json, asset_path, updated_by_user_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, field_name) DO UPDATE SET
			value_json = excluded.value_json,
			asset_path = excluded.asset_path,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = CURRENT_TIMESTAMP
	`, workID, field, valueJSON, assetPath, userID)
	return err
}

func normalizeManualOverrideField(field string) string {
	switch strings.ToLower(strings.TrimSpace(field)) {
	case "title":
		return "title"
	case "circle":
		return "circle"
	case "series":
		return "series"
	case "voice_actors", "voiceactors", "voices":
		return "voice_actors"
	case "cover":
		return "cover"
	default:
		return ""
	}
}

func normalizeManualEntity(value *manualOverrideEntity) *manualOverrideEntity {
	if value == nil {
		return nil
	}
	name := strings.TrimSpace(value.Name)
	externalID := strings.ToUpper(strings.TrimSpace(value.ExternalID))
	if name == "" && externalID == "" {
		return nil
	}
	return &manualOverrideEntity{Name: name, ExternalID: externalID}
}

func normalizeManualSeries(value *manualOverrideSeries) *manualOverrideSeries {
	if value == nil {
		return nil
	}
	name := strings.TrimSpace(value.Name)
	titleID := strings.TrimSpace(value.TitleID)
	circleID := strings.ToUpper(strings.TrimSpace(value.CircleExternalID))
	if name == "" && titleID == "" && circleID == "" {
		return nil
	}
	return &manualOverrideSeries{Name: name, TitleID: titleID, CircleExternalID: circleID}
}

func normalizeManualPeople(values []manualOverridePerson) []manualOverridePerson {
	people := []manualOverridePerson{}
	seen := map[string]bool{}
	for _, value := range values {
		name := strings.TrimSpace(value.Name)
		if name == "" {
			continue
		}
		personID := value.PersonID
		if personID < 0 {
			personID = 0
		}
		key := strings.ToUpper(name) + ":" + strconv.FormatInt(personID, 10)
		if seen[key] {
			continue
		}
		seen[key] = true
		people = append(people, manualOverridePerson{Name: name, PersonID: personID})
	}
	return people
}

func manualPeopleNames(values []manualOverridePerson) []string {
	names := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value.Name) != "" {
			names = append(names, value.Name)
		}
	}
	return names
}

func manualPeopleCredits(values []manualOverridePerson) []voiceCredit {
	credits := make([]voiceCredit, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value.Name) == "" {
			continue
		}
		credits = append(credits, voiceCredit{PersonID: value.PersonID, DisplayName: value.Name})
	}
	return credits
}

func syncManualOverrideRelations(ctx context.Context, tx *sql.Tx, workID int64, circle *manualOverrideEntity, series *manualOverrideSeries, actors []manualOverridePerson) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_party WHERE work_id = ? AND role = 'circle' AND source = 'manual_override'", workID); err != nil {
		return err
	}
	if circle != nil {
		if partyID, ok, err := partyIDForExternalID(ctx, tx, circle.ExternalID); err != nil {
			return err
		} else if ok {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO work_party (work_id, party_id, role, source, updated_at)
				VALUES (?, ?, 'circle', 'manual_override', CURRENT_TIMESTAMP)
				ON CONFLICT(work_id, party_id, role) DO UPDATE SET
					source = excluded.source,
					updated_at = CURRENT_TIMESTAMP
			`, workID, partyID); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_credit WHERE work_id = ? AND role = 'voice_actor' AND source = 'manual_override'", workID); err != nil {
		return err
	}
	for _, actor := range actors {
		if ok, err := personIDExists(ctx, tx, actor.PersonID); err != nil {
			return err
		} else if ok {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO work_credit (work_id, person_id, role, source, updated_at)
				VALUES (?, ?, 'voice_actor', 'manual_override', CURRENT_TIMESTAMP)
				ON CONFLICT(work_id, person_id, role) DO UPDATE SET
					source = excluded.source,
					updated_at = CURRENT_TIMESTAMP
			`, workID, actor.PersonID); err != nil {
				return err
			}
		}
	}
	if series != nil {
		if seriesID, ok, err := seriesIDForTitle(ctx, tx, series.TitleID, series.CircleExternalID); err != nil {
			return err
		} else if ok {
			var code string
			if err := tx.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO party_series_work (series_id, primary_code, updated_at)
				VALUES (?, ?, CURRENT_TIMESTAMP)
				ON CONFLICT(series_id, primary_code) DO UPDATE SET
					updated_at = CURRENT_TIMESTAMP
			`, seriesID, strings.ToUpper(strings.TrimSpace(code))); err != nil {
				return err
			}
		}
	}
	return nil
}

func deleteManualOverrideRelations(ctx context.Context, tx *sql.Tx, workID int64, field string) error {
	switch field {
	case "circle":
		_, err := tx.ExecContext(ctx, "DELETE FROM work_party WHERE work_id = ? AND role = 'circle' AND source = 'manual_override'", workID)
		return err
	case "voice_actors":
		_, err := tx.ExecContext(ctx, "DELETE FROM work_credit WHERE work_id = ? AND role = 'voice_actor' AND source = 'manual_override'", workID)
		return err
	default:
		return nil
	}
}
