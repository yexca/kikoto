package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"sort"
	"strings"
	"time"
)

func (s *Server) discoverVoiceCatalogSource(ctx context.Context, runID int64, source remoteSourceForUse, queries []string, mode string, previous voiceCatalogSourceStatus, projector remoteCatalogProjector) voiceCatalogSourceResult {
	result := voiceCatalogSourceResult{
		Source: source,
		Status: voiceCatalogSourceStatus{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName,
			Status: "ok", Cursors: append([]voiceCatalogQueryCursor{}, previous.Cursors...),
		},
		Candidates: []voiceCatalogCandidate{},
	}
	if !isKikoeruSourceType(source.SourceType) {
		result.Status.Status = "unsupported"
		return result
	}
	if !source.Enabled {
		result.Status.Status = "disabled"
		return result
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		result.Status.Status = "misconfigured"
		result.Status.Error = "Remote source API endpoint is not configured."
		return result
	}

	started := time.Now()
	sourceCtx, cancel := context.WithTimeout(ctx, voiceCatalogSourceTimeout)
	defer cancel()
	client := s.kikoeruCrawlClientForSource(ctx, source)
	candidates := map[string]voiceCatalogCandidate{}
	queryCursors := make([]voiceCatalogQueryCursor, 0, len(queries))
	fullSnapshot := true
	for _, query := range queries {
		keyword := voiceCatalogSearchKeyword(query)
		if keyword == "" {
			continue
		}
		cursor, queryFull, stop := s.discoverVoiceCatalogQuery(sourceCtx, runID, source, client, query, keyword, mode, previous, projector, started, &result, candidates)
		if stop {
			return result
		}
		queryCursors = append(queryCursors, cursor)
		if !queryFull {
			fullSnapshot = false
		}
	}

	result.Candidates = make([]voiceCatalogCandidate, 0, len(candidates))
	canonicalCodes := map[string]bool{}
	for _, candidate := range candidates {
		result.Candidates = append(result.Candidates, candidate)
		canonicalCodes[candidate.CanonicalCode] = true
	}
	sort.Slice(result.Candidates, func(left int, right int) bool {
		if result.Candidates[left].CanonicalCode != result.Candidates[right].CanonicalCode {
			return result.Candidates[left].CanonicalCode < result.Candidates[right].CanonicalCode
		}
		return result.Candidates[left].RemoteCode < result.Candidates[right].RemoteCode
	})
	result.Status.Total = len(canonicalCodes)
	result.Status.Matches = len(canonicalCodes)
	result.Status.Cursors = queryCursors
	result.Status.ElapsedMS = time.Since(started).Milliseconds()
	result.Complete = true
	result.Full = fullSnapshot
	_ = s.updateSourceHealth(context.WithoutCancel(ctx), source.ID, "healthy")
	return result
}

func (s *Server) discoverVoiceCatalogQuery(sourceCtx context.Context, runID int64, source remoteSourceForUse, client *kikoeru.Client, query, keyword, mode string, previous voiceCatalogSourceStatus, projector remoteCatalogProjector, started time.Time, result *voiceCatalogSourceResult, candidates map[string]voiceCatalogCandidate) (voiceCatalogQueryCursor, bool, bool) {
	state := newVoiceCatalogQueryState(mode, previous, query)
	for pageNumber := 1; ; pageNumber++ {
		if runID > 0 {
			if err := s.ensureWorkflowRunActive(sourceCtx, runID); err != nil {
				result.Status.Status, result.Status.Error = "error", "Voice catalog refresh was cancelled."
				result.Status.ElapsedMS = time.Since(started).Milliseconds()
				return voiceCatalogQueryCursor{}, false, true
			}
		}
		// Recent-added order is the only order used for the incremental boundary.
		// Release dates and work codes are never used as ordering cursors.
		page, err := client.ListWorksSorted(sourceCtx, pageNumber, voiceRemotePageSize, keyword, "create_date", "desc")
		if err != nil {
			result.Err = err
			result.Status.Status, result.Status.Error = voiceRemoteSourceErrorStatus(err, sourceCtx.Err())
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			if !shutdownInterrupted(sourceCtx) {
				_ = s.updateSourceHealth(context.WithoutCancel(sourceCtx), source.ID, "unavailable")
			}
			return voiceCatalogQueryCursor{}, false, true
		}
		result.Status.Pages++
		duplicate := state.observePage(pageNumber, page)
		if duplicate {
			result.Status.Status, result.Status.Error = "invalid_response", "Remote source pagination did not advance."
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			_ = s.updateSourceHealth(context.WithoutCancel(sourceCtx), source.ID, "unavailable")
			return voiceCatalogQueryCursor{}, false, true
		}
		if err := s.addVoiceCatalogPageCandidates(sourceCtx, source.ID, page.Works, projector, candidates); err != nil {
			result.Err = err
			result.Status.Status, result.Status.Error = "error", "Voice catalog matching failed."
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			return voiceCatalogQueryCursor{}, false, true
		}
		if state.incremental && voiceCatalogPageContainsFrontier(page.Works, state.frontier) {
			return voiceCatalogQueryCursor{Query: query, Frontier: state.nextFrontier}, false, false
		}
		if voiceCatalogPageComplete(pageNumber, voiceRemotePageSize, state.reportedTotal, page) {
			break
		}
		if len(page.Works) == 0 {
			result.Status.Status, result.Status.Error = "invalid_response", "Remote source pagination ended before its reported total."
			result.Status.ElapsedMS = time.Since(started).Milliseconds()
			_ = s.updateSourceHealth(context.WithoutCancel(sourceCtx), source.ID, "unavailable")
			return voiceCatalogQueryCursor{}, false, true
		}
	}
	if !state.sortApplied {
		state.nextFrontier = nil
	}
	return voiceCatalogQueryCursor{Query: query, Frontier: state.nextFrontier}, true, false
}

type voiceCatalogQueryState struct {
	frontier      []string
	incremental   bool
	sortApplied   bool
	nextFrontier  []string
	seenPages     map[string]bool
	reportedTotal int
}

func newVoiceCatalogQueryState(mode string, previous voiceCatalogSourceStatus, query string) voiceCatalogQueryState {
	frontier := voiceCatalogCursorFrontier(previous.Cursors, query)
	return voiceCatalogQueryState{
		frontier: frontier, incremental: mode == "incremental" && len(frontier) > 0,
		sortApplied: true, nextFrontier: []string{}, seenPages: map[string]bool{},
	}
}

func (state *voiceCatalogQueryState) observePage(pageNumber int, page kikoeru.WorksPage) bool {
	if !page.SortApplied {
		state.sortApplied, state.incremental = false, false
	}
	if pageNumber == 1 && page.SortApplied {
		state.nextFrontier = voiceCatalogPageFrontier(page.Works)
	}
	if total := voiceCatalogPaginationTotal(page.Pagination); total > state.reportedTotal {
		state.reportedTotal = total
	}
	signature := voiceCatalogPageSignature(page.Works)
	if signature != "" && state.seenPages[signature] {
		return true
	}
	if signature != "" {
		state.seenPages[signature] = true
	}
	return false
}

func (s *Server) addVoiceCatalogPageCandidates(ctx context.Context, sourceID int64, works []kikoeru.Work, projector remoteCatalogProjector, candidates map[string]voiceCatalogCandidate) error {
	for _, remoteWork := range works {
		candidate, ok, err := s.voiceCatalogCandidate(ctx, sourceID, remoteWork, projector)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		key := candidate.CanonicalCode + "\x1f" + candidate.RemoteCode
		if _, exists := candidates[key]; !exists {
			candidates[key] = candidate
		}
	}
	return nil
}

func voiceCatalogSearchKeyword(query string) string {
	query = strings.Map(func(value rune) rune {
		if value == '$' || value < ' ' || value == 0x7f {
			return ' '
		}
		return value
	}, strings.TrimSpace(query))
	query = strings.Join(strings.Fields(query), " ")
	if query == "" {
		return ""
	}
	return "$va:" + query + "$"
}

func (s *Server) voiceCatalogCandidate(ctx context.Context, sourceID int64, work kikoeru.Work, projector remoteCatalogProjector) (voiceCatalogCandidate, bool, error) {
	projection := projector.project(sourceID, work)
	remoteCode := normalizeDLsiteCode(projection.RemoteCode)
	if remoteCode == "" {
		return voiceCatalogCandidate{}, false, nil
	}
	ref, err := s.canonicalWorkForCode(ctx, remoteCode)
	if err != nil {
		return voiceCatalogCandidate{}, false, err
	}
	canonicalCode := remoteCode
	if ref.Code != "" {
		canonicalCode = ref.Code
	}
	raw, err := json.Marshal(work)
	if err != nil {
		return voiceCatalogCandidate{}, false, err
	}
	return voiceCatalogCandidate{
		CanonicalCode: canonicalCode, WorkID: ref.WorkID, RemoteCode: remoteCode,
		Projection: projection, RawJSON: string(raw),
	}, true, nil
}

func voiceCatalogPaginationTotal(pagination kikoeru.Pagination) int {
	for _, total := range []int{pagination.TotalCount, pagination.Total, pagination.Count} {
		if total > 0 {
			return total
		}
	}
	return 0
}

func voiceCatalogPageComplete(pageNumber int, requestedPageSize int, reportedTotal int, page kikoeru.WorksPage) bool {
	pageSize := page.Pagination.PageSize
	if pageSize <= 0 {
		pageSize = requestedPageSize
	}
	currentPage := page.Pagination.CurrentPage
	if currentPage <= 0 {
		currentPage = page.Pagination.Page
	}
	if currentPage <= 0 {
		currentPage = pageNumber
	}
	if reportedTotal > 0 {
		return currentPage*pageSize >= reportedTotal
	}
	return len(page.Works) < requestedPageSize
}

func voiceCatalogPageSignature(works []kikoeru.Work) string {
	if len(works) == 0 {
		return ""
	}
	var signature strings.Builder
	for _, work := range works {
		signature.WriteString(normalizedRemoteWorkCode(work))
		signature.WriteByte(':')
		fmt.Fprint(&signature, work.ID)
		signature.WriteByte('|')
	}
	return signature.String()
}

func voiceCatalogCursorFrontier(cursors []voiceCatalogQueryCursor, query string) []string {
	for _, cursor := range cursors {
		if strings.EqualFold(strings.TrimSpace(cursor.Query), strings.TrimSpace(query)) {
			return append([]string{}, cursor.Frontier...)
		}
	}
	return nil
}

func voiceCatalogPageFrontier(works []kikoeru.Work) []string {
	frontier := make([]string, 0, len(works))
	seen := map[string]bool{}
	for _, work := range works {
		identity := voiceCatalogRemoteIdentity(work)
		if identity == "" || seen[identity] {
			continue
		}
		seen[identity] = true
		frontier = append(frontier, identity)
	}
	return frontier
}

func voiceCatalogPageContainsFrontier(works []kikoeru.Work, frontier []string) bool {
	if len(frontier) == 0 {
		return false
	}
	known := make(map[string]bool, len(frontier))
	for _, identity := range frontier {
		known[identity] = true
	}
	for _, work := range works {
		if known[voiceCatalogRemoteIdentity(work)] {
			return true
		}
	}
	return false
}

func voiceCatalogRemoteIdentity(work kikoeru.Work) string {
	if work.ID > 0 {
		return fmt.Sprintf("id:%d", work.ID)
	}
	if code := normalizedRemoteWorkCode(work); code != "" {
		return "code:" + code
	}
	return ""
}
