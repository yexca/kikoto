package httpapi

import (
	"context"

	"github.com/yexca/kikoto/backend/internal/personal"
)

// canonicalWorkIDs maps each work to the canonical work of its family, which
// holds the family's personal state, and lists the canonical works once each.
func (s *Server) canonicalWorkIDs(ctx context.Context, workIDs []int64) (map[int64]int64, []int64, error) {
	canonical := make(map[int64]int64, len(workIDs))
	unique := []int64{}
	seen := map[int64]bool{}
	pending := []int64{}
	for _, id := range workIDs {
		if id > 0 && !seen[id] {
			seen[id] = true
			pending = append(pending, id)
		}
	}
	seen = map[int64]bool{}
	for start := 0; start < len(pending); start += 500 {
		batch := pending[start:min(start+500, len(pending))]
		rows, err := s.db.QueryContext(ctx, `SELECT work.id, `+personal.CanonicalWorkIDSQL("work.id")+` FROM work WHERE work.id IN (`+sqlPlaceholders(len(batch))+`)`, int64Args(batch)...)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var id, family int64
			if err := rows.Scan(&id, &family); err != nil {
				_ = rows.Close()
				return nil, nil, err
			}
			canonical[id] = family
			if !seen[family] {
				seen[family] = true
				unique = append(unique, family)
			}
		}
		if err := rows.Close(); err != nil {
			return nil, nil, err
		}
	}
	return canonical, unique, nil
}

// byRequestedWork hands each requested work the value its canonical work
// holds, or empty when it holds none.
func byRequestedWork[T any](workIDs []int64, canonical map[int64]int64, values map[int64]T, empty func() T) map[int64]T {
	result := make(map[int64]T, len(workIDs))
	for _, id := range workIDs {
		if id <= 0 {
			continue
		}
		if value, ok := values[canonical[id]]; ok {
			result[id] = value
		} else {
			result[id] = empty()
		}
	}
	return result
}
