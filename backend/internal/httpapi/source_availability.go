package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type sourceAvailabilityResponse struct {
	WorkCode  string                      `json:"workCode"`
	CheckedAt string                      `json:"checkedAt"`
	Sources   []sourceAvailabilitySummary `json:"sources"`
}

type sourceAvailabilitySummary struct {
	SourceID    int64  `json:"sourceId"`
	SourceCode  string `json:"sourceCode"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
	RemoteID    string `json:"remoteId"`
	PrimaryCode string `json:"primaryCode"`
	Title       string `json:"title"`
	CoverURL    string `json:"coverUrl"`
	WorkID      *int64 `json:"workId"`
	HasRemote   bool   `json:"hasRemote"`
	HasTracked  bool   `json:"hasTracked"`
	HasCache    bool   `json:"hasCache"`
	HasLocal    bool   `json:"hasLocal"`
	Error       string `json:"error"`
	ElapsedMS   int64  `json:"elapsedMs"`
}

type sourceAvailabilityCheckRequest struct {
	SourceID int64 `json:"sourceId"`
	Force    bool  `json:"force"`
}

func (s *Server) getWorkSourceAvailability(w http.ResponseWriter, r *http.Request) {
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	if !s.requireDemoWorkCode(w, r, code) {
		return
	}
	response, err := s.readWorkSourceAvailability(r.Context(), code)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) checkWorkSourceAvailabilityNow(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	if !s.requireDemoWorkCode(w, r, code) {
		return
	}
	var payload sourceAvailabilityCheckRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	response, err := s.checkWorkSourceAvailabilityForSources(r.Context(), code, payload.SourceID, "manual", "work_detail_source_check")
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) checkWorkSourceAvailabilityForSources(ctx context.Context, code string, onlySourceID int64, triggerType string, triggerReason string) (sourceAvailabilityResponse, error) {
	return s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, code, onlySourceID, nil, triggerType, triggerReason)
}

func (s *Server) checkWorkSourceAvailabilityForSourcesWithHealth(ctx context.Context, code string, onlySourceID int64, allowedSourceIDs map[int64]bool, triggerType string, triggerReason string) (sourceAvailabilityResponse, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return sourceAvailabilityResponse{}, err
	}
	checkedAt := time.Now().UTC().Format(time.RFC3339)
	results := make([]sourceAvailabilitySummary, 0, len(sources))
	for _, source := range sources {
		if onlySourceID > 0 && source.ID != onlySourceID {
			continue
		}
		if allowedSourceIDs != nil && !allowedSourceIDs[source.ID] {
			continue
		}
		result, err := s.checkOneWorkSourceAvailability(ctx, source, code, triggerType)
		if err != nil {
			return sourceAvailabilityResponse{}, err
		}
		results = append(results, result)
	}
	if err := s.recordSourceAvailabilityObservation(ctx, code, results); err != nil {
		return sourceAvailabilityResponse{}, err
	}
	return sourceAvailabilityResponse{
		WorkCode: code, CheckedAt: checkedAt, Sources: results,
	}, nil
}

func (s *Server) checkOneWorkSourceAvailability(ctx context.Context, source remoteSourceForUse, code, triggerType string) (sourceAvailabilitySummary, error) {
	result := sourceAvailabilitySummary{SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName, Status: "disabled"}
	if !isKikoeruSourceType(source.SourceType) {
		result.Status = "unavailable"
		result.Error = "source is not a supported kikoeru source"
		return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code)
	}
	if !source.Enabled {
		return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code)
	}
	requestClass := sourceRequestCrawl
	if triggerType == "manual" {
		requestClass = sourceRequestInteractive
	}
	started := time.Now()
	remoteWork, err := s.checkRemoteWorkAvailabilityWithClass(ctx, source, code, requestClass)
	result.ElapsedMS = time.Since(started).Milliseconds()
	if err != nil {
		result.Status = "error"
		result.Error = "remote source request failed"
		if isNotFoundLikeError(err) {
			result.Status = "not_found"
			result.Error = "work was not found"
		}
		slog.Warn("remote source availability check failed", "source_id", source.ID, "work_code", code, "error", err)
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code)
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = code
	}
	result.Status = "available"
	result.RemoteID = strconv.FormatInt(remoteWork.ID, 10)
	result.PrimaryCode = workCode
	result.Title = firstNonEmpty(remoteWork.Title, remoteWork.Name, workCode)
	result.CoverURL = firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL)
	return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, workCode)
}

func (s *Server) recordSourceAvailabilityObservation(ctx context.Context, code string, results []sourceAvailabilitySummary) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.recordAvailabilityPresence(ctx, tx, code, results); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) healthyRemoteSourceIDsForAvailability(ctx context.Context, onlySourceID int64) (map[int64]bool, error) {
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	healthy := map[int64]bool{}
	for _, source := range sources {
		if onlySourceID > 0 && source.ID != onlySourceID {
			continue
		}
		if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
			continue
		}
		if strings.TrimSpace(source.Endpoint.APIURL) == "" {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			continue
		}
		checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := s.checkRemoteSourceHealthWithClass(checkCtx, source, sourceRequestCrawl)
		cancel()
		if err != nil {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			continue
		}
		_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		healthy[source.ID] = true
	}
	return healthy, nil
}

func (s *Server) checkRemoteSourceHealth(ctx context.Context, source remoteSourceForUse) error {
	return s.checkRemoteSourceHealthWithClass(ctx, source, sourceRequestInteractive)
}

func (s *Server) checkRemoteSourceHealthWithClass(ctx context.Context, source remoteSourceForUse, class sourceRequestClass) error {
	client := s.kikoeruClientForSourceClass(source, class)
	if err := client.Health(ctx); err == nil {
		return nil
	}
	_, err := client.ListWorks(ctx, 1, 1, "")
	return err
}

func (s *Server) readWorkSourceAvailability(ctx context.Context, code string) (sourceAvailabilityResponse, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return sourceAvailabilityResponse{}, err
	}
	checkedAt, err := s.latestSourceAvailabilityCheckedAt(ctx, code)
	if err != nil {
		return sourceAvailabilityResponse{}, err
	}
	results := make([]sourceAvailabilitySummary, 0, len(sources))
	for _, source := range sources {
		result := sourceAvailabilitySummary{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName, Status: "unknown",
		}
		if !isKikoeruSourceType(source.SourceType) {
			result.Status = "unavailable"
			result.Error = "source is not a supported kikoeru source"
		} else if !source.Enabled {
			result.Status = "disabled"
		}
		if err := s.attachCachedSourcePresence(ctx, &result, source.ID, code); err != nil {
			return sourceAvailabilityResponse{}, err
		}
		if err := s.attachSourceAvailabilityFlags(ctx, &result, source.ID, firstNonEmpty(result.PrimaryCode, code)); err != nil {
			return sourceAvailabilityResponse{}, err
		}
		results = append(results, result)
	}
	return sourceAvailabilityResponse{WorkCode: code, CheckedAt: checkedAt, Sources: results}, nil
}

func (s *Server) latestSourceAvailabilityCheckedAt(ctx context.Context, code string) (string, error) {
	var checkedAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT MAX(presence.last_checked_at)
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE work.primary_code = ?
			AND presence.presence_type = ?
	`, code, sourcePresenceTypeRemoteSource).Scan(&checkedAt)
	if err != nil {
		return "", err
	}
	if !checkedAt.Valid {
		return "", nil
	}
	return checkedAt.String, nil
}

func (s *Server) attachCachedSourcePresence(ctx context.Context, result *sourceAvailabilitySummary, sourceID int64, workCode string) error {
	var availability, remoteID, rawJSON sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT presence.availability, presence.remote_id, presence.raw_json
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE work.primary_code = ?
			AND presence.file_source_id = ?
			AND presence.presence_type = ?
	`, workCode, sourceID, sourcePresenceTypeRemoteSource).Scan(&availability, &remoteID, &rawJSON)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	switch availability.String {
	case "available":
		result.Status = "available"
	case "missing":
		result.Status = "not_found"
	case "disabled":
		result.Status = "disabled"
	case "unavailable":
		result.Status = "error"
	case "unknown":
		if result.Status == "" {
			result.Status = "unknown"
		}
	}
	result.RemoteID = remoteID.String
	if rawJSON.Valid {
		var cached struct {
			PrimaryCode string `json:"primary_code"`
			Title       string `json:"title"`
			CoverURL    string `json:"cover_url"`
			Error       string `json:"error"`
			ElapsedMS   int64  `json:"elapsed_ms"`
		}
		if json.Unmarshal([]byte(rawJSON.String), &cached) == nil {
			result.PrimaryCode = cached.PrimaryCode
			result.Title = cached.Title
			result.CoverURL = cached.CoverURL
			result.Error = cached.Error
			result.ElapsedMS = cached.ElapsedMS
		}
	}
	return nil
}

func (s *Server) attachSourceAvailabilityFlags(ctx context.Context, result *sourceAvailabilitySummary, sourceID int64, workCode string) error {
	flags, err := s.sourceAvailabilityFlags(ctx, sourceID, workCode)
	if err != nil {
		return err
	}
	result.WorkID = flags.WorkID
	result.HasRemote = flags.HasRemote
	result.HasTracked = flags.HasTracked
	result.HasCache = flags.HasCache
	result.HasLocal = flags.HasLocal
	return nil
}

func (s *Server) loadRemoteSourcesForAvailability(ctx context.Context) ([]remoteSourceForUse, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.code, source.display_name, source.source_type, source.enabled, source.config_json,
			COALESCE(endpoint.api_url, ''), COALESCE(endpoint.base_url, ''), COALESCE(endpoint.fallback_url, ''),
			COALESCE(endpoint.work_url_template, ''), COALESCE(endpoint.restrict_outbound_hosts, 0),
			COALESCE(endpoint.allowed_host_patterns_json, '[]')
		FROM file_source AS source
		LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		WHERE source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
		ORDER BY source.priority ASC, source.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	sources := []remoteSourceForUse{}
	for rows.Next() {
		var source remoteSourceForUse
		var configJSON, allowedHostPatternsJSON string
		if err := rows.Scan(
			&source.ID,
			&source.Code,
			&source.DisplayName,
			&source.SourceType,
			&source.Enabled,
			&configJSON,
			&source.Endpoint.APIURL,
			&source.Endpoint.BaseURL,
			&source.Endpoint.FallbackURL,
			&source.Endpoint.WorkURLTemplate,
			&source.Endpoint.RestrictOutboundHosts,
			&allowedHostPatternsJSON,
		); err != nil {
			return nil, err
		}
		if strings.TrimSpace(source.Endpoint.APIURL) == "" {
			source.Endpoint.APIURL = source.Endpoint.BaseURL
		}
		if strings.TrimSpace(configJSON) != "" {
			_ = json.Unmarshal([]byte(configJSON), &source.Config)
		}
		normalizeFileSourceConfig(&source.Config, source.SourceType)
		_ = json.Unmarshal([]byte(allowedHostPatternsJSON), &source.Endpoint.AllowedHostPatterns)
		if source.Endpoint.AllowedHostPatterns == nil {
			source.Endpoint.AllowedHostPatterns = []string{}
		}
		sources = append(sources, source)
	}
	return sources, rows.Err()
}

func (s *Server) checkRemoteWorkAvailabilityWithClass(ctx context.Context, source remoteSourceForUse, code string, class sourceRequestClass) (kikoeru.Work, error) {
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return kikoeru.Work{}, fmt.Errorf("source has no API endpoint")
	}
	client := s.kikoeruClientForSourceClass(source, class)
	remoteWork, _, err := s.resolveKikoeruWork(ctx, client, code)
	return remoteWork, err
}

type sourceAvailabilityState struct {
	WorkID     *int64
	HasRemote  bool
	HasTracked bool
	HasCache   bool
	HasLocal   bool
}

func (s *Server) sourceAvailabilityFlags(ctx context.Context, sourceID int64, workCode string) (sourceAvailabilityState, error) {
	var flags sourceAvailabilityState
	ref, err := s.canonicalWorkForCode(ctx, workCode)
	if err != nil {
		return flags, err
	}
	if !ref.Known || ref.WorkID <= 0 {
		return flags, nil
	}
	flags.WorkID = &ref.WorkID
	ids, err := s.familyWorkIDsForCode(ctx, ref.Code)
	if err != nil {
		return flags, err
	}
	for _, workID := range ids {
		flags.HasRemote = flags.HasRemote || s.workHasLocationType(ctx, workID, sourceID, "remote_stream") || s.workHasSourcePresence(ctx, workID, sourceID, sourcePresenceTypeRemoteSource, "available")
		flags.HasTracked = flags.HasTracked || s.workHasSourcePresence(ctx, workID, sourceID, "tracked", "available")
		flags.HasCache = flags.HasCache || s.workHasLocationType(ctx, workID, sourceID, "cache")
		flags.HasLocal = flags.HasLocal || s.workHasLocationType(ctx, workID, 0, "local") || s.workHasSourcePresence(ctx, workID, 0, "local", "available")
	}
	return flags, nil
}

func (s *Server) workHasLocationType(ctx context.Context, workID int64, sourceID int64, locationType string) bool {
	query := `
		SELECT 1
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.location_type = ?
			AND location.availability = 'available'
	`
	args := []any{workID, locationType}
	if sourceID > 0 {
		query += " AND location.file_source_id = ?"
		args = append(args, sourceID)
	}
	query += " LIMIT 1"
	var found int
	return s.db.QueryRowContext(ctx, query, args...).Scan(&found) == nil
}

func (s *Server) workHasSourcePresence(ctx context.Context, workID int64, sourceID int64, presenceType string, availability string) bool {
	query := `
		SELECT 1
		FROM work_source_presence
		WHERE work_id = ?
			AND presence_type = ?
			AND availability = ?
	`
	args := []any{workID, presenceType, availability}
	if sourceID > 0 {
		query += " AND file_source_id = ?"
		args = append(args, sourceID)
	}
	query += " LIMIT 1"
	var found int
	return s.db.QueryRowContext(ctx, query, args...).Scan(&found) == nil
}

func (s *Server) recordAvailabilityPresence(ctx context.Context, tx *sql.Tx, code string, results []sourceAvailabilitySummary) error {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return nil
	}
	var workID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	for _, result := range results {
		if result.SourceID <= 0 {
			continue
		}
		availability := "unknown"
		switch result.Status {
		case "available":
			availability = "available"
		case "not_found":
			availability = "missing"
		case "disabled":
			availability = "disabled"
		case "error", "unavailable":
			availability = "unavailable"
		}
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID:       workID,
			FileSourceID: result.SourceID,
			PresenceType: sourcePresenceTypeRemoteSource,
			RemoteID:     result.RemoteID,
			RemoteCode:   result.PrimaryCode,
			Availability: availability,
			RawJSON: mustJSON(map[string]any{
				"status":       result.Status,
				"primary_code": result.PrimaryCode,
				"title":        result.Title,
				"cover_url":    result.CoverURL,
				"error":        result.Error,
				"elapsed_ms":   result.ElapsedMS,
			}),
		}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) runSourceChangeAvailabilityChecks(ctx context.Context, sourceID int64, reason string) {
	healthySourceIDs, err := s.healthyRemoteSourceIDsForAvailability(ctx, sourceID)
	if err != nil || len(healthySourceIDs) == 0 {
		return
	}
	codes, err := s.localWorkCodesNeedingRemoteAvailability(ctx, sourceID, 0, 100)
	if err != nil {
		return
	}
	seen := map[string]bool{}
	for _, rawCode := range codes {
		code := strings.ToUpper(strings.TrimSpace(rawCode))
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		checkCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		_, _ = s.checkWorkSourceAvailabilityForSourcesWithHealth(checkCtx, code, sourceID, healthySourceIDs, "source_poll", reason)
		cancel()
	}
}

func (s *Server) localWorkCodesNeedingRemoteAvailability(ctx context.Context, sourceID int64, staleAfter time.Duration, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 50
	}
	staleCutoff := time.Now().UTC().Add(-staleAfter).Format("2006-01-02 15:04:05")
	query := `
		SELECT DISTINCT work.primary_code
		FROM work
		WHERE work.primary_code <> ''
			AND EXISTS (
				SELECT 1
				FROM work_source_presence AS local_presence
				WHERE local_presence.work_id = work.id
					AND local_presence.presence_type = 'local'
					AND local_presence.availability = 'available'
			)
			AND (
	`
	args := []any{}
	if sourceID > 0 {
		query += `
				NOT EXISTS (
					SELECT 1 FROM work_source_presence AS presence
					WHERE presence.work_id = work.id
						AND presence.file_source_id = ?
						AND presence.presence_type = ?
				)
				OR EXISTS (
					SELECT 1 FROM work_source_presence AS presence
					WHERE presence.work_id = work.id
						AND presence.file_source_id = ?
						AND presence.presence_type = ?
				)
		`
		args = append(args, sourceID, sourcePresenceTypeRemoteSource, sourceID, sourcePresenceTypeRemoteSource)
	} else {
		query += `
				NOT EXISTS (
					SELECT 1 FROM work_source_presence AS presence
					WHERE presence.work_id = work.id
						AND presence.presence_type = ?
				)
		`
		args = append(args, sourcePresenceTypeRemoteSource)
		if staleAfter > 0 {
			query += `
				OR EXISTS (
					SELECT 1 FROM work_source_presence AS presence
					WHERE presence.work_id = work.id
						AND presence.presence_type = ?
						AND (presence.last_checked_at IS NULL OR presence.last_checked_at < ?)
				)
			`
			args = append(args, sourcePresenceTypeRemoteSource, staleCutoff)
		}
	}
	query += `
			)
		ORDER BY work.updated_at DESC, work.id DESC
		LIMIT ?
	`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
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
