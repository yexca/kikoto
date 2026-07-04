package httpapi

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

const voiceRemotePageSize = 48

type voiceSummary struct {
	PersonID        string             `json:"personId"`
	DisplayName     string             `json:"displayName"`
	Aliases         []string           `json:"aliases"`
	KnownWorks      int                `json:"knownWorks"`
	LocalWorks      int                `json:"localWorks"`
	RemoteWorks     int                `json:"remoteWorks"`
	CachedWorks     int                `json:"cachedWorks"`
	PlayableWorks   int                `json:"playableWorks"`
	LastSeenAt      *string            `json:"lastSeenAt"`
	SourceSummaries []circleSourceStat `json:"sourceSummaries"`
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
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	summaries, err := s.loadVoiceSummaries(r.Context())
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
	name, err := decodeVoicePersonID(r.PathValue("personId"))
	if err != nil || strings.TrimSpace(name) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid voice person id"})
		return
	}
	summaries, err := s.loadVoiceSummaries(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	var summary *voiceSummary
	for index := range summaries {
		if sameVoiceName(summaries[index].DisplayName, name) {
			summary = &summaries[index]
			break
		}
	}
	if summary == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
		return
	}
	works, err := s.loadVoiceKnownWorks(r.Context(), user.ID, summary.DisplayName)
	if err != nil {
		writeError(w, err)
		return
	}
	matches, err := s.searchVoiceRemoteSources(r.Context(), summary.DisplayName)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, voiceDetail{voiceSummary: *summary, Works: works, RemoteMatches: matches})
}

func (s *Server) loadVoiceSummaries(ctx context.Context) ([]voiceSummary, error) {
	rows, err := s.db.QueryContext(ctx, voiceWorksBaseQuery())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type aggregate struct {
		summary voiceSummary
		codes   map[string]bool
		local   map[string]bool
		remote  map[string]bool
		cache   map[string]bool
	}
	byName := map[string]*aggregate{}
	for rows.Next() {
		work, err := scanVoiceWorkRow(rows)
		if err != nil {
			return nil, err
		}
		metadata := parseDLsiteSnapshot(work.Snapshot)
		if len(metadata.VoiceActors) == 0 {
			metadata.VoiceActors = parseKikoeruVoiceActors(work.Snapshot)
		}
		for _, actor := range metadata.VoiceActors {
			name := strings.TrimSpace(actor)
			if name == "" {
				continue
			}
			key := voiceNameKey(name)
			item := byName[key]
			if item == nil {
				item = &aggregate{
					summary: voiceSummary{
						PersonID:        encodeVoicePersonID(name),
						DisplayName:     name,
						Aliases:         []string{},
						SourceSummaries: []circleSourceStat{},
					},
					codes:  map[string]bool{},
					local:  map[string]bool{},
					remote: map[string]bool{},
					cache:  map[string]bool{},
				}
				byName[key] = item
			}
			item.codes[work.PrimaryCode] = true
			if work.HasLocal {
				item.local[work.PrimaryCode] = true
			}
			if work.HasRemote {
				item.remote[work.PrimaryCode] = true
			}
			if work.HasCache {
				item.cache[work.PrimaryCode] = true
			}
			if item.summary.LastSeenAt == nil || strings.Compare(work.UpdatedAt, *item.summary.LastSeenAt) > 0 {
				seen := work.UpdatedAt
				item.summary.LastSeenAt = &seen
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	summaries := []voiceSummary{}
	for _, item := range byName {
		item.summary.KnownWorks = len(item.codes)
		item.summary.LocalWorks = len(item.local)
		item.summary.RemoteWorks = len(item.remote)
		item.summary.CachedWorks = len(item.cache)
		item.summary.PlayableWorks = countUnion(item.local, item.cache, item.remote)
		item.summary.SourceSummaries = voiceSourceSummaries(item.summary.LocalWorks, item.summary.RemoteWorks, item.summary.CachedWorks)
		summaries = append(summaries, item.summary)
	}
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].KnownWorks == summaries[j].KnownWorks {
			return summaries[i].DisplayName < summaries[j].DisplayName
		}
		return summaries[i].KnownWorks > summaries[j].KnownWorks
	})
	return summaries, nil
}

func (s *Server) loadVoiceKnownWorks(ctx context.Context, userID int64, voiceName string) ([]voiceKnownWork, error) {
	rows, err := s.db.QueryContext(ctx, voiceWorksBaseQueryWithUser(), userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	works := []voiceKnownWork{}
	for rows.Next() {
		row, err := scanVoiceWorkRowWithUser(rows)
		if err != nil {
			return nil, err
		}
		metadata := parseDLsiteSnapshot(row.Snapshot)
		actors := metadata.VoiceActors
		if len(actors) == 0 {
			actors = parseKikoeruVoiceActors(row.Snapshot)
		}
		if !voiceNamesContain(actors, voiceName) {
			continue
		}
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(works, func(i, j int) bool {
		left := ""
		right := ""
		if works[i].ReleaseDate != nil {
			left = *works[i].ReleaseDate
		}
		if works[j].ReleaseDate != nil {
			right = *works[j].ReleaseDate
		}
		if left == right {
			return works[i].PrimaryCode > works[j].PrimaryCode
		}
		return left > right
	})
	return works, nil
}

func (s *Server) searchVoiceRemoteSources(ctx context.Context, voiceName string) ([]voiceRemoteSourceSet, error) {
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
	return results, nil
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
	UpdatedAt       string
	Snapshot        string
	CircleLink      sql.NullString
	ListeningStatus string
	HasLocal        bool
	HasRemote       bool
	HasCache        bool
}

func voiceWorksBaseQuery() string {
	return `
		SELECT
			work.id,
			work.primary_code,
			work.title,
			work.release_date,
			work.updated_at,
			COALESCE((
				SELECT snapshot_json
				FROM metadata_snapshot
				WHERE metadata_snapshot.work_id = work.id
				ORDER BY fetched_at DESC, id DESC
				LIMIT 1
			), '') AS snapshot_json,
			'' AS party_link,
			'none' AS listening_status,
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
		FROM work
		ORDER BY work.updated_at DESC
	`
}

func voiceWorksBaseQueryWithUser() string {
	return `
		SELECT
			work.id,
			work.primary_code,
			work.title,
			work.release_date,
			work.updated_at,
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
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id
			AND user_work_state.user_id = ?
		ORDER BY work.updated_at DESC
	`
}

func scanVoiceWorkRow(rows *sql.Rows) (voiceWorkRow, error) {
	var item voiceWorkRow
	var hasLocal, hasRemote, hasCache int
	err := rows.Scan(&item.ID, &item.PrimaryCode, &item.Title, &item.ReleaseDate, &item.UpdatedAt, &item.Snapshot, &item.CircleLink, &item.ListeningStatus, &hasLocal, &hasRemote, &hasCache)
	item.HasLocal = hasLocal != 0
	item.HasRemote = hasRemote != 0
	item.HasCache = hasCache != 0
	return item, err
}

func scanVoiceWorkRowWithUser(rows *sql.Rows) (voiceWorkRow, error) {
	return scanVoiceWorkRow(rows)
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

func encodeVoicePersonID(name string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strings.TrimSpace(name)))
}

func decodeVoicePersonID(value string) (string, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func voiceNameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func sameVoiceName(left string, right string) bool {
	return voiceNameKey(left) == voiceNameKey(right)
}

func voiceNamesContain(values []string, name string) bool {
	for _, value := range values {
		if sameVoiceName(value, name) {
			return true
		}
	}
	return false
}

func countUnion(groups ...map[string]bool) int {
	seen := map[string]bool{}
	for _, group := range groups {
		for key := range group {
			seen[key] = true
		}
	}
	return len(seen)
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
