package remotemetadata

import (
	"context"
	"sort"
)

// Source is one remote file source ranked for metadata use.
type Source struct {
	FileSourceID int64
	Code         string
	DisplayName  string
	SourceType   string
	Enabled      bool
	Capable      bool
	Selected     bool
	ProviderCode string
	Rank         int
}

// Active reports whether the opt-in fallback may request or fold this source.
func (s Source) Active(settings Settings) bool {
	return settings.Enabled && s.Selected && s.Capable && s.Enabled
}

// LoadSources ranks every remote source: selected sources in their configured
// order first, then the others by source priority and id. The rank decides
// which source's value a work shows, independently of when it was written.
func LoadSources(ctx context.Context, q Querier, settings Settings) ([]Source, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, code, display_name, source_type, enabled, config_json, priority
		FROM file_source ORDER BY priority ASC, id ASC`)
	if err != nil {
		return nil, err
	}
	position := map[int64]int{}
	for index, id := range settings.SourceIDs {
		position[id] = index
	}
	type ranked struct {
		source   Source
		priority int
	}
	items := []ranked{}
	for rows.Next() {
		var item ranked
		var configJSON string
		if err := rows.Scan(&item.source.FileSourceID, &item.source.Code, &item.source.DisplayName, &item.source.SourceType,
			&item.source.Enabled, &configJSON, &item.priority); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if !IsRemoteSourceType(item.source.SourceType) {
			continue
		}
		item.source.Capable = SupportsMetadata(item.source.SourceType, configJSON)
		_, item.source.Selected = position[item.source.FileSourceID]
		item.source.ProviderCode = ProviderCode(item.source.Code)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	sort.SliceStable(items, func(left, right int) bool {
		a, b := items[left].source, items[right].source
		if a.Selected != b.Selected {
			return a.Selected
		}
		if a.Selected {
			return position[a.FileSourceID] < position[b.FileSourceID]
		}
		if items[left].priority != items[right].priority {
			return items[left].priority < items[right].priority
		}
		return a.FileSourceID < b.FileSourceID
	})
	result := make([]Source, len(items))
	for index, item := range items {
		item.source.Rank = index
		result[index] = item.source
	}
	return result, nil
}

// ActiveSources returns the sources the fallback may use, in order.
func ActiveSources(ctx context.Context, q Querier, settings Settings) ([]Source, error) {
	sources, err := LoadSources(ctx, q, settings)
	if err != nil {
		return nil, err
	}
	result := []Source{}
	for _, source := range sources {
		if source.Active(settings) {
			result = append(result, source)
		}
	}
	return result, nil
}
