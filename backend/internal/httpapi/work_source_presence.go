package httpapi

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type workSourcePresence struct {
	WorkID       int64
	FileSourceID int64
	PresenceType string
	RemoteID     string
	RemoteCode   string
	SourceURL    string
	Availability string
	RawJSON      string
}

const sourcePresenceTypeRemoteSource = "source"

func upsertWorkSourcePresence(ctx context.Context, tx *sql.Tx, presence workSourcePresence) error {
	presence.PresenceType = strings.TrimSpace(presence.PresenceType)
	if presence.PresenceType == "" {
		presence.PresenceType = "location"
	}
	presence.Availability = strings.TrimSpace(presence.Availability)
	if presence.Availability == "" {
		presence.Availability = "unknown"
	}
	presence.RawJSON = strings.TrimSpace(presence.RawJSON)
	if presence.RawJSON == "" {
		presence.RawJSON = "{}"
	}
	presence.RemoteCode = normalizeDLsiteCode(presence.RemoteCode)
	if presence.RemoteCode == "" {
		presence.RemoteCode = normalizeDLsiteCode(remoteCodeFromRawJSON(presence.RawJSON))
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO work_source_presence (
			work_id,
			file_source_id,
			presence_type,
			remote_id,
			remote_code,
			source_url,
			availability,
			raw_json,
			last_seen_at,
			last_checked_at,
			updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, file_source_id, presence_type) DO UPDATE SET
			remote_id = excluded.remote_id,
			remote_code = excluded.remote_code,
			source_url = excluded.source_url,
			availability = excluded.availability,
			raw_json = excluded.raw_json,
			last_seen_at = CASE
				WHEN excluded.availability = 'available' THEN excluded.last_seen_at
				ELSE work_source_presence.last_seen_at
			END,
			last_checked_at = excluded.last_checked_at,
			updated_at = CURRENT_TIMESTAMP
	`, presence.WorkID, presence.FileSourceID, presence.PresenceType, presence.RemoteID, presence.RemoteCode, presence.SourceURL, presence.Availability, presence.RawJSON)
	return err
}

func upsertAvailableRemoteSourcePresence(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, remoteWork kikoeru.Work, workID int64) error {
	code := normalizedRemoteWorkCode(remoteWork)
	return upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: sourcePresenceTypeRemoteSource,
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		RemoteCode:   code,
		SourceURL:    remoteWork.SourceURL,
		Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"status":       "available",
			"primary_code": code,
			"title":        firstNonEmpty(remoteWork.Title, remoteWork.Name, code),
			"cover_url":    firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL),
		}),
	})
}

type sourcePresenceItem struct {
	Type           string `json:"type"`
	Availability   string `json:"availability"`
	WorkID         int64  `json:"workId,omitempty"`
	FileSourceID   int64  `json:"fileSourceId"`
	FileSourceCode string `json:"fileSourceCode"`
	FileSourceName string `json:"fileSourceName"`
	RemoteID       string `json:"remoteId"`
	RemoteCode     string `json:"remoteCode"`
	SourceURL      string `json:"sourceUrl"`
	Forked         *bool  `json:"forked,omitempty"`
}

func (s *Server) sourcePresenceForCode(ctx context.Context, code string) []sourcePresenceItem {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			presence.presence_type,
			presence.availability,
			presence.work_id,
			presence.file_source_id,
			COALESCE(source.code, ''),
			COALESCE(source.display_name, ''),
			COALESCE(presence.remote_id, ''),
			COALESCE(presence.source_url, ''),
			COALESCE(presence.remote_code, '')
		FROM work_source_presence AS presence
		LEFT JOIN file_source AS source ON source.id = presence.file_source_id
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
		ORDER BY presence.presence_type, source.display_name, presence.file_source_id
	`, code, code)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	items, err := scanSourcePresenceRows(rows)
	if err != nil {
		return nil
	}
	if err := rows.Close(); err != nil {
		return nil
	}
	s.enrichTrackedPresenceForkState(ctx, code, items)
	return items
}

func parseSourcePresenceSummary(raw string) []sourcePresenceItem {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	items := []sourcePresenceItem{}
	seen := map[string]int{}
	for _, part := range strings.Split(raw, ",") {
		item, ok := parseSourcePresenceSummaryItem(strings.TrimSpace(part))
		if !ok {
			continue
		}
		key := sourcePresenceItemKey(item)
		if index, ok := seen[key]; ok {
			mergeSourcePresenceItem(&items[index], item)
			continue
		}
		seen[key] = len(items)
		items = append(items, item)
	}
	return items
}

func parseSourcePresenceSummaryItem(part string) (sourcePresenceItem, bool) {
	if part == "" {
		return sourcePresenceItem{}, false
	}
	item := sourcePresenceItem{}
	if strings.Contains(part, "|") {
		item = parseDelimitedSourcePresenceItem(strings.Split(part, "|"))
	} else {
		presenceType, availability, ok := strings.Cut(part, ":")
		if !ok {
			return sourcePresenceItem{}, false
		}
		item.Type = strings.TrimSpace(presenceType)
		item.Availability = strings.TrimSpace(availability)
	}
	if !normalizeSourcePresenceItem(&item) {
		return sourcePresenceItem{}, false
	}
	return item, true
}

func parseDelimitedSourcePresenceItem(fields []string) sourcePresenceItem {
	item := sourcePresenceItem{}
	if len(fields) > 0 {
		item.Type = strings.TrimSpace(fields[0])
	}
	if len(fields) > 1 {
		item.Availability = strings.TrimSpace(fields[1])
	}
	if len(fields) > 2 {
		item.FileSourceID, _ = strconv.ParseInt(strings.TrimSpace(fields[2]), 10, 64)
	}
	if len(fields) > 3 {
		item.FileSourceCode = strings.TrimSpace(fields[3])
	}
	if len(fields) > 4 {
		item.FileSourceName = strings.TrimSpace(fields[4])
	}
	if len(fields) > 5 {
		item.RemoteID = strings.TrimSpace(fields[5])
	}
	if len(fields) > 6 {
		item.SourceURL = strings.TrimSpace(fields[6])
	}
	if len(fields) > 7 {
		item.RemoteCode = strings.TrimSpace(fields[7])
	}
	if len(fields) > 8 {
		item.WorkID, _ = strconv.ParseInt(strings.TrimSpace(fields[8]), 10, 64)
	}
	return item
}

func normalizeSourcePresenceItem(item *sourcePresenceItem) bool {
	item.Type = strings.TrimSpace(item.Type)
	if item.Type == "" {
		return false
	}
	item.Availability = strings.TrimSpace(item.Availability)
	if item.Availability == "" {
		item.Availability = "unknown"
	}
	return true
}

func sourcePresenceItemKey(item sourcePresenceItem) string {
	return fmt.Sprintf("%s:%d:%d:%s", strings.ToLower(item.Type), item.WorkID, item.FileSourceID, strings.ToLower(item.Availability))
}

func scanSourcePresenceRows(rows *sql.Rows) ([]sourcePresenceItem, error) {
	items := []sourcePresenceItem{}
	seen := map[string]int{}
	for rows.Next() {
		var item sourcePresenceItem
		if err := rows.Scan(
			&item.Type,
			&item.Availability,
			&item.WorkID,
			&item.FileSourceID,
			&item.FileSourceCode,
			&item.FileSourceName,
			&item.RemoteID,
			&item.SourceURL,
			&item.RemoteCode,
		); err != nil {
			return nil, err
		}
		if !normalizeSourcePresenceItem(&item) {
			continue
		}
		key := sourcePresenceItemKey(item)
		if index, ok := seen[key]; ok {
			mergeSourcePresenceItem(&items[index], item)
			continue
		}
		seen[key] = len(items)
		items = append(items, item)
	}
	return items, rows.Err()
}

func mergeSourcePresenceItem(target *sourcePresenceItem, item sourcePresenceItem) {
	if target.WorkID == 0 {
		target.WorkID = item.WorkID
	}
	if target.RemoteCode == "" {
		target.RemoteCode = item.RemoteCode
	}
	if target.RemoteID == "" {
		target.RemoteID = item.RemoteID
	}
	if target.SourceURL == "" {
		target.SourceURL = item.SourceURL
	}
}
