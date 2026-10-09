package httpapi

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/yexca/kikoto/backend/internal/metadatatitles"
)

const (
	// availabilityWatchMaxFamilyCodes bounds the remote requests one target
	// can cause in a run.
	availabilityWatchMaxFamilyCodes = 32
	// availabilityWatchMetadataRefresh is the SQLite modifier for how long a
	// target's family metadata stays fresh before a run synchronizes it again.
	availabilityWatchMetadataRefresh = "-1 day"
)

// availabilityWatchFamilyMember is one language edition, or a provider-declared
// edition code without its own work, of a watched code's family.
type availabilityWatchFamilyMember struct {
	Code      string `json:"code"`
	Title     string `json:"title"`
	Language  string `json:"language"`
	Canonical bool   `json:"canonical"`
}

type availabilityWatchFamilyMetadata struct {
	Synced  []string
	Failed  []string
	Skipped int
}

// loadAvailabilityWatchFamilies returns the known family of each root code
// selected by rootsSQL, which must select one `code` column. A code without
// stored family metadata has no entry.
func (s *Server) loadAvailabilityWatchFamilies(ctx context.Context, rootsSQL string, args ...any) (map[string][]availabilityWatchFamilyMember, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH root(code) AS (`+rootsSQL+`),
		member(logical_work_id, code, language, canonical, title, edition) AS (
			SELECT edition.logical_work_id, UPPER(edition.primary_code), edition.metadata_language,
				edition.is_canonical, work.title, 1
			FROM work_edition AS edition
			INNER JOIN work ON work.id = edition.work_id
			UNION ALL
			SELECT alias.logical_work_id, UPPER(alias.primary_code), alias.metadata_language, 0, '', 0
			FROM work_code_alias AS alias
		),
		root_family(code, logical_work_id) AS (
			SELECT root.code, MIN(member.logical_work_id)
			FROM root
			INNER JOIN member ON member.code = UPPER(root.code)
			GROUP BY root.code
		)
		SELECT UPPER(root_family.code), member.code, member.language, member.canonical, member.title
		FROM root_family
		INNER JOIN member ON member.logical_work_id = root_family.logical_work_id
		ORDER BY root_family.code, member.edition DESC, member.canonical DESC, member.code
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	families := map[string][]availabilityWatchFamilyMember{}
	seen := map[string]bool{}
	for rows.Next() {
		var root string
		var member availabilityWatchFamilyMember
		if err := rows.Scan(&root, &member.Code, &member.Language, &member.Canonical, &member.Title); err != nil {
			return nil, err
		}
		// Edition rows sort before aliases, so an alias of a persisted
		// edition never replaces its title.
		key := root + "\x00" + member.Code
		if seen[key] || len(families[root]) >= availabilityWatchMaxFamilyCodes {
			continue
		}
		seen[key] = true
		member.Title = metadatatitles.Display(member.Title, !member.Canonical)
		families[root] = append(families[root], member)
	}
	return families, rows.Err()
}

// availabilityWatchFamilyCodes lists the codes whose remote availability
// satisfies a watched code: the code itself first, then its family editions.
func (s *Server) availabilityWatchFamilyCodes(ctx context.Context, code string) ([]string, error) {
	families, err := s.loadAvailabilityWatchFamilies(ctx, "SELECT ?", code)
	if err != nil {
		return nil, err
	}
	codes := []string{code}
	for _, member := range families[code] {
		if member.Code != code && len(codes) < availabilityWatchMaxFamilyCodes {
			codes = append(codes, member.Code)
		}
	}
	return codes, nil
}

// refreshAvailabilityWatchFamilyMetadata synchronizes the DLsite family of a
// watched code when its stored family is missing or stale, so a translation
// published since the last run is checked too. Metadata failures never stop the
// availability check; it then uses the family already known.
func (s *Server) refreshAvailabilityWatchFamilyMetadata(ctx context.Context, syncer dlsiteFamilyMetadataSyncer, targetID int64, code string, metadata *availabilityWatchFamilyMetadata) error {
	var stale bool
	if err := s.db.QueryRowContext(ctx, `
		SELECT metadata_synced_at IS NULL OR metadata_synced_at < datetime('now', ?)
		FROM availability_watch_target WHERE id = ?
	`, availabilityWatchMetadataRefresh, targetID).Scan(&stale); err != nil {
		return err
	}
	if !stale {
		metadata.Skipped++
		return nil
	}
	family, err := syncer.SyncFamily(ctx, code)
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	if err != nil && !family.RequestedUnavailable {
		// Retry on the next run; a code DLsite does not list is settled.
		slog.Warn("availability watch family metadata sync failed", "work_code", code, "error", err)
		metadata.Failed = append(metadata.Failed, fmt.Sprintf("%s: family metadata could not be refreshed", code))
		return nil
	}
	if err == nil {
		metadata.Synced = append(metadata.Synced, code)
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE availability_watch_target SET metadata_synced_at = CURRENT_TIMESTAMP WHERE id = ?
	`, targetID)
	return err
}

// availabilityWatchFamilyCover is the watched code's own cover, or the
// original edition's cover that every edition of the family shows.
func (s *Server) availabilityWatchFamilyCover(code string, family []availabilityWatchFamilyMember) string {
	if coverURL := s.coverURL(code); coverURL != "" {
		return coverURL
	}
	for _, member := range family {
		if member.Canonical && member.Code != code {
			return s.coverURL(member.Code)
		}
	}
	return ""
}

func availabilityWatchFamilyTitle(code string, family []availabilityWatchFamilyMember) string {
	for _, member := range family {
		if member.Code == code && member.Title != "" {
			return member.Title
		}
	}
	for _, member := range family {
		if member.Canonical && member.Title != "" {
			return member.Title
		}
	}
	return ""
}
