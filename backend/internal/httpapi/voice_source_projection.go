package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"strconv"
	"strings"
)

func (s *Server) workSourceStateByCode(ctx context.Context, code string) ([]circleSourceStat, []voiceRemoteObservation, error) {
	tags, err := s.availableVoiceSourceTags(ctx, code)
	if err != nil {
		return nil, nil, err
	}
	observedTags, remoteObservations, err := s.observedVoiceSourceTags(ctx, code)
	if err != nil {
		return nil, nil, err
	}
	tagIndexes := make(map[string]int, len(tags)+len(observedTags))
	for index, tag := range tags {
		tagIndexes[circleSourceStatKey(tag)] = index
	}
	for _, tag := range observedTags {
		mergeObservedVoiceSourceTag(&tags, tagIndexes, tag)
	}
	if sourceStatsContain(tags, "remote") {
		tags = append([]circleSourceStat{{Key: "remote", DisplayName: "Remote", Status: "available", Count: 1}}, tags...)
	}
	return tags, remoteObservations, nil
}

func (s *Server) availableVoiceSourceTags(ctx context.Context, code string) ([]circleSourceStat, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.display_name, location.location_type, COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE item.work_id IN (
				SELECT work.id
				FROM work
				WHERE UPPER(work.primary_code) = UPPER(?)
				UNION
				SELECT sibling.work_id
				FROM work AS current_work
				INNER JOIN work_edition AS current_edition ON current_edition.work_id = current_work.id
				INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
				WHERE UPPER(current_work.primary_code) = UPPER(?)
			)
			AND location.availability = 'available'
		GROUP BY source.id, source.display_name, location.location_type
		ORDER BY source.priority ASC, source.display_name ASC
	`, code, code)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []circleSourceStat{}
	tagIndexes := map[string]int{}
	for rows.Next() {
		var sourceID int64
		var name, locationType string
		var count int
		if err := rows.Scan(&sourceID, &name, &locationType, &count); err != nil {
			return nil, err
		}
		switch locationType {
		case "local":
			mergeAvailableVoiceSourceTag(&tags, tagIndexes, circleSourceStat{Key: "local", DisplayName: "Local", Status: "available", Count: count})
		case "cache":
			mergeAvailableVoiceSourceTag(&tags, tagIndexes, circleSourceStat{Key: "cache", SourceID: &sourceID, DisplayName: "Cache", Status: "available", Count: count})
		case "remote_stream", "remote_download":
			mergeAvailableVoiceSourceTag(&tags, tagIndexes, circleSourceStat{Key: fmt.Sprintf("source:%d", sourceID), SourceID: &sourceID, DisplayName: name, Status: "available", Count: count})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return tags, nil
}

// Source presence is a work-level availability observation. It can make the
// remote source available without implying that concrete media rows exist.
func (s *Server) observedVoiceSourceTags(ctx context.Context, code string) ([]circleSourceStat, []voiceRemoteObservation, error) {
	presenceRows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.code, source.display_name, presence.remote_code, presence.availability, COUNT(*)
		FROM work_source_presence AS presence
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE presence.work_id IN (
				SELECT work.id
				FROM work
				WHERE UPPER(work.primary_code) = UPPER(?)
				UNION
				SELECT sibling.work_id
				FROM work AS current_work
				INNER JOIN work_edition AS current_edition ON current_edition.work_id = current_work.id
				INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
				WHERE UPPER(current_work.primary_code) = UPPER(?)
			)
			AND presence.presence_type = ?
		GROUP BY source.id, source.code, source.display_name, source.priority, presence.remote_code, presence.availability
		ORDER BY source.priority ASC, source.display_name ASC, presence.availability ASC, presence.remote_code ASC
	`, code, code, sourcePresenceTypeRemoteSource)
	if err != nil {
		return nil, nil, err
	}
	defer presenceRows.Close()
	observedStats := map[int64]circleSourceStat{}
	observedSourceOrder := []int64{}
	remoteObservations := []voiceRemoteObservation{}
	for presenceRows.Next() {
		var sourceID int64
		var sourceCode, name, remoteCode, availability string
		var count int
		if err := presenceRows.Scan(&sourceID, &sourceCode, &name, &remoteCode, &availability, &count); err != nil {
			return nil, nil, err
		}
		status := voiceSourceAvailabilityStatus(availability)
		if status != "available" {
			count = 0
		}
		item := circleSourceStat{
			Key:         fmt.Sprintf("source:%d", sourceID),
			SourceID:    &sourceID,
			DisplayName: name,
			Status:      status,
			Count:       count,
		}
		existing, ok := observedStats[sourceID]
		if !ok {
			observedSourceOrder = append(observedSourceOrder, sourceID)
			observedStats[sourceID] = item
		} else if voiceSourceStatusPriority(item.Status) > voiceSourceStatusPriority(existing.Status) {
			observedStats[sourceID] = item
		} else if item.Status == existing.Status && item.Status == "available" {
			existing.Count += item.Count
			observedStats[sourceID] = existing
		}
		remoteCode = strings.TrimSpace(remoteCode)
		if remoteCode != "" {
			remoteObservations = mergeVoiceRemoteObservations(remoteObservations, []voiceRemoteObservation{{
				SourceID:   sourceID,
				SourceCode: sourceCode,
				SourceName: name,
				RemoteCode: remoteCode,
				Status:     status,
			}})
		}
	}
	if err := presenceRows.Err(); err != nil {
		return nil, nil, err
	}
	observedTags := make([]circleSourceStat, 0, len(observedSourceOrder))
	for _, sourceID := range observedSourceOrder {
		observedTags = append(observedTags, observedStats[sourceID])
	}
	return observedTags, remoteObservations, nil
}

func mergeAvailableVoiceSourceTag(tags *[]circleSourceStat, indexes map[string]int, item circleSourceStat) {
	key := circleSourceStatKey(item)
	if index, ok := indexes[key]; ok {
		(*tags)[index].Status = "available"
		(*tags)[index].Count += item.Count
		return
	}
	indexes[key] = len(*tags)
	*tags = append(*tags, item)
}

func mergeObservedVoiceSourceTag(tags *[]circleSourceStat, indexes map[string]int, item circleSourceStat) {
	key := circleSourceStatKey(item)
	if index, ok := indexes[key]; ok {
		existing := &(*tags)[index]
		if existing.Status == "available" {
			return
		}
		if voiceSourceStatusPriority(item.Status) > voiceSourceStatusPriority(existing.Status) {
			existing.Status = item.Status
			existing.Count = item.Count
		}
		return
	}
	indexes[key] = len(*tags)
	*tags = append(*tags, item)
}

func voiceSourceAvailabilityStatus(availability string) string {
	switch strings.ToLower(strings.TrimSpace(availability)) {
	case "available":
		return "available"
	case "missing", "not_found":
		return "not_found"
	case "unavailable":
		return "unavailable"
	case "disabled":
		return "disabled"
	case "error":
		return "error"
	default:
		return "unknown"
	}
}

func voiceSourceStatusPriority(status string) int {
	switch status {
	case "available":
		return 6
	case "disabled":
		return 5
	case "error":
		return 4
	case "unavailable":
		return 3
	case "not_found":
		return 2
	case "unknown":
		return 1
	default:
		return 0
	}
}

type voiceWorkRow struct {
	ID              int64
	PrimaryCode     string
	Title           string
	ReleaseDate     sql.NullString
	AgeRating       string
	Rating          *float64
	Sales           *int64
	RegularPrice    *int64
	Price           *int64
	PriceCurrency   string
	PermanentlyFree *bool
	CardSummary     string
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
	var rating sql.NullFloat64
	var sales, regularPrice, currentPrice sql.NullInt64
	var permanentlyFree sql.NullBool
	err := rows.Scan(&item.ID, &item.PrimaryCode, &item.Title, &item.ReleaseDate, &item.AgeRating,
		&rating, &sales, &regularPrice, &currentPrice, &item.PriceCurrency, &permanentlyFree,
		&item.CardSummary, &item.Snapshot, &item.CircleLink, &item.ListeningStatus, &favorite, &hasLocal, &hasRemote, &hasCache, &item.SeriesTitleID)
	item.Rating = sqlutil.Float64(rating)
	item.Sales = sqlutil.Int64(sales)
	item.RegularPrice = sqlutil.Int64(regularPrice)
	item.Price = sqlutil.Int64(currentPrice)
	if permanentlyFree.Valid {
		item.PermanentlyFree = &permanentlyFree.Bool
	}
	item.Favorite = favorite != 0
	item.HasLocal = hasLocal != 0
	item.HasRemote = hasRemote != 0
	item.HasCache = hasCache != 0
	return item, err
}

func parseKikoeruVoiceActors(raw string) []string {
	identities := parseKikoeruVoiceActorIdentities(raw)
	names := make([]string, 0, len(identities))
	for _, identity := range identities {
		names = append(names, identity.Name)
	}
	return names
}

func parseKikoeruVoiceActorIdentities(raw string) []voiceActorIdentity {
	if strings.TrimSpace(raw) == "" {
		return []voiceActorIdentity{}
	}
	var payload struct {
		VAs []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"vas"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return []voiceActorIdentity{}
	}
	seen := map[string]bool{}
	actors := []voiceActorIdentity{}
	for _, va := range payload.VAs {
		name := strings.TrimSpace(va.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		actors = append(actors, voiceActorIdentity{Name: name, ExternalID: strings.TrimSpace(va.ID)})
	}
	return actors
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
