package httpapi

import (
	"context"
	"fmt"
)

// attachRemoteWorkLibraryState gives each card of a returned remote page the
// state its work holds in this library: the same source presence,
// availability, and personal tags a Library card shows. It runs once on the
// final page, and copies the page because summaries can be shared with the
// browse cache that serves every viewer.
func (s *Server) attachRemoteWorkLibraryState(ctx context.Context, userID int64, works []remoteWorkSummary) ([]remoteWorkSummary, error) {
	attached := append([]remoteWorkSummary(nil), works...)
	ids := []int64{}
	seen := map[int64]bool{}
	for index := range attached {
		attached[index].SourcePresence = []sourcePresenceItem{}
		attached[index].Availability = []string{}
		attached[index].UserTags = []workUserTag{}
		if workID := attached[index].WorkID; workID != nil && !seen[*workID] {
			seen[*workID] = true
			ids = append(ids, *workID)
		}
	}
	summaries := make(map[int64]libraryWorkSummary, len(ids))
	// The Library list reads at most 100 works at a time.
	for start := 0; start < len(ids); start += 100 {
		chunk := ids[start:min(start+100, len(ids))]
		args := make([]any, len(chunk))
		for index, id := range chunk {
			args[index] = id
		}
		raw, err := s.libraryStore.ListMatching(ctx, userID, fmt.Sprintf("work.id IN (%s)", sqlPlaceholders(len(chunk))), args, 1, len(chunk), s.cfg.IsDemo())
		if err != nil {
			return nil, err
		}
		scanned, err := s.scanLibraryWorkRows(ctx, userID, raw, true)
		if err != nil {
			return nil, err
		}
		for _, summary := range scanned {
			summaries[summary.ID] = summary
		}
	}
	for index := range attached {
		if attached[index].WorkID == nil {
			continue
		}
		summary, ok := summaries[*attached[index].WorkID]
		if !ok {
			continue
		}
		if summary.SourcePresence != nil {
			attached[index].SourcePresence = summary.SourcePresence
		}
		if summary.Availability != nil {
			attached[index].Availability = summary.Availability
		}
		if summary.UserTags != nil {
			attached[index].UserTags = summary.UserTags
		}
	}
	return attached, nil
}
