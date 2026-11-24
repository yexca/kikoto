package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// Local work cleanup deletes the local files of whole work families, found by
// the administrator's own star rating and Quick mark, size, and storage pool,
// and ordered by size or rating. A search keeps at most a
// chosen number of works and pages through them. A request queues one media
// cleanup run that cleans the works in turn and can also clear the
// administrator's rating and Quick mark and forget the works.
const (
	// localWorkCleanupHighRating is the lowest rating a request must confirm
	// a second time before its works' files are deleted.
	localWorkCleanupHighRating     = 3
	localWorkCleanupDefaultPage    = 20
	maxLocalWorkCleanupPageSize    = 200
	localWorkCleanupDefaultLimit   = 50
	maxLocalWorkCleanupWorks       = 500
	localWorkCleanupAuditAction    = "local_work_cleanup.queue"
	localWorkCleanupHighRatingCode = "high_rating_unconfirmed"
)

// Listening filters a search accepts. Settled works are those not queued to
// be heard: without a Quick mark, or finished.
const (
	localWorkCleanupListeningAny      = "any"
	localWorkCleanupListeningNone     = "none"
	localWorkCleanupListeningFinished = "finished"
	localWorkCleanupListeningSettled  = "settled"
)

// Ratings a search accepts besides a highest star count.
const (
	localWorkCleanupRatingAny     = "any"
	localWorkCleanupRatingUnrated = "unrated"
)

// Orders a search accepts, each ascending or descending: by size, or by rating
// with unrated works last and larger works first within a rating.
const (
	localWorkCleanupSortSize   = "size"
	localWorkCleanupSortRating = "rating"
)

type localWorkCleanupFolder struct {
	ID       int64  `json:"id"`
	Path     string `json:"path"`
	Online   bool   `json:"online"`
	workID   int64
	sourceID int64
	pool     string
}

type localWorkCleanupCandidate struct {
	WorkID           int64                    `json:"workId"`
	PrimaryCode      string                   `json:"primaryCode"`
	Title            string                   `json:"title"`
	CoverURL         string                   `json:"coverUrl"`
	Rating           *int                     `json:"rating"`
	ListeningStatus  string                   `json:"listeningStatus"`
	SizeBytes        int64                    `json:"sizeBytes"`
	FileCount        int                      `json:"fileCount"`
	UnknownSizeFiles int                      `json:"unknownSizeFiles"`
	Folders          []localWorkCleanupFolder `json:"folders"`
	Offline          bool                     `json:"offline"`
	// SourceAvailable reports that another source still provides the work,
	// so forgetting keeps it.
	SourceAvailable bool `json:"sourceAvailable"`
	familyWorkIDs   []int64
}

type localWorkCleanupPool struct {
	Path   string `json:"path"`
	Online bool   `json:"online"`
}

// localWorkCleanupListResponse is one page of a search. Total counts the works
// the search keeps, at most its limit; Matched counts every matching work.
type localWorkCleanupListResponse struct {
	Works    []localWorkCleanupCandidate `json:"works"`
	Total    int                         `json:"total"`
	Matched  int                         `json:"matched"`
	Limit    int                         `json:"limit"`
	Page     int                         `json:"page"`
	PageSize int                         `json:"pageSize"`
	// Pools lists the storage pools a search can be narrowed to; it is empty
	// for a standard library.
	Pools []localWorkCleanupPool `json:"pools"`
}

type localWorkCleanupFilter struct {
	// MaxRating keeps the works rated at most that many stars; 0 keeps every
	// work. UnratedOnly keeps only the unrated works.
	MaxRating   int
	UnratedOnly bool
	Listening   string
	MinBytes    int64
	// Pool keeps the works with a folder on that storage pool, when PoolSet.
	Pool       string
	PoolSet    bool
	Sort       string
	Descending bool
	Limit      int
}

func (filter localWorkCleanupFilter) matches(candidate localWorkCleanupCandidate) bool {
	switch {
	case filter.UnratedOnly:
		if candidate.Rating != nil {
			return false
		}
	case filter.MaxRating > 0:
		if candidate.Rating == nil || *candidate.Rating > filter.MaxRating {
			return false
		}
	}
	switch filter.Listening {
	case localWorkCleanupListeningNone, localWorkCleanupListeningFinished:
		if candidate.ListeningStatus != filter.Listening {
			return false
		}
	case localWorkCleanupListeningSettled:
		if candidate.ListeningStatus != localWorkCleanupListeningNone && candidate.ListeningStatus != localWorkCleanupListeningFinished {
			return false
		}
	}
	if candidate.SizeBytes < filter.MinBytes {
		return false
	}
	if filter.PoolSet {
		onPool := false
		for _, folder := range candidate.Folders {
			if strings.EqualFold(folder.pool, filter.Pool) {
				onPool = true
				break
			}
		}
		if !onPool {
			return false
		}
	}
	return true
}

func (s *Server) listLocalWorkCleanup(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	filter, err := parseLocalWorkCleanupFilter(r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
		return
	}
	page := max(queryInt(r, "page", 1), 1)
	pageSize := queryInt(r, "pageSize", localWorkCleanupDefaultPage)
	if pageSize <= 0 || pageSize > maxLocalWorkCleanupPageSize {
		pageSize = localWorkCleanupDefaultPage
	}
	candidates, err := s.loadLocalWorkCleanupCandidates(r.Context(), user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	matching := make([]localWorkCleanupCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		if filter.matches(candidate) {
			matching = append(matching, candidate)
		}
	}
	sortLocalWorkCleanupCandidates(matching, filter.Sort, filter.Descending)
	kept := matching[:min(len(matching), filter.Limit)]
	start := min((page-1)*pageSize, len(kept))
	end := min(start+pageSize, len(kept))
	works := kept[start:end]
	if err := s.applyLocalWorkCleanupTitles(r.Context(), works); err != nil {
		writeError(w, err)
		return
	}
	// Covers are looked up for the returned page only: each lookup reads the
	// cover cache on disk.
	for index := range works {
		coverURL, err := s.workCoverURL(r.Context(), works[index].WorkID, works[index].PrimaryCode)
		if err != nil {
			writeError(w, err)
			return
		}
		works[index].CoverURL = coverURL
	}
	pools, err := s.localWorkCleanupPools(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, localWorkCleanupListResponse{
		Works: works, Total: len(kept), Matched: len(matching), Limit: filter.Limit,
		Page: page, PageSize: pageSize, Pools: pools,
	})
}

// localWorkCleanupPools lists the registered storage pools of a pooled
// library, in their configured order.
func (s *Server) localWorkCleanupPools(ctx context.Context) ([]localWorkCleanupPool, error) {
	pools := []localWorkCleanupPool{}
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil || !layout.poolsMode() {
		return pools, err
	}
	availability, err := s.loadLibraryAvailability(ctx)
	if err != nil {
		return nil, err
	}
	for _, pool := range layout.Pools {
		pools = append(pools, localWorkCleanupPool{Path: pool.Path, Online: availability.online[strings.ToLower(pool.Path)]})
	}
	return pools, nil
}

func parseLocalWorkCleanupFilter(r *http.Request) (localWorkCleanupFilter, error) {
	query := r.URL.Query()
	filter := localWorkCleanupFilter{
		Listening: localWorkCleanupListeningAny, Sort: localWorkCleanupSortSize, Limit: localWorkCleanupDefaultLimit,
	}
	switch value := strings.TrimSpace(query.Get("rating")); value {
	case "", localWorkCleanupRatingAny:
	case localWorkCleanupRatingUnrated:
		filter.UnratedOnly = true
	default:
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 5 {
			return filter, fmt.Errorf("rating must be any, unrated, or a whole number from 1 to 5")
		}
		filter.MaxRating = parsed
	}
	switch value := strings.TrimSpace(query.Get("listening")); value {
	case "":
	case localWorkCleanupListeningAny, localWorkCleanupListeningNone, localWorkCleanupListeningFinished, localWorkCleanupListeningSettled:
		filter.Listening = value
	default:
		return filter, fmt.Errorf("listening must be any, none, finished, or settled")
	}
	if value := strings.TrimSpace(query.Get("minBytes")); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 0 {
			return filter, fmt.Errorf("minBytes must be a whole number of bytes")
		}
		filter.MinBytes = parsed
	}
	if query.Has("pool") {
		filter.Pool, filter.PoolSet = strings.TrimSpace(query.Get("pool")), true
	}
	switch value := strings.TrimSpace(query.Get("sort")); value {
	case "":
	case localWorkCleanupSortSize, localWorkCleanupSortRating:
		filter.Sort = value
	default:
		return filter, fmt.Errorf("sort must be size or rating")
	}
	// Size is largest first and rating lowest first unless asked otherwise.
	switch value := strings.TrimSpace(query.Get("direction")); value {
	case "":
		filter.Descending = filter.Sort == localWorkCleanupSortSize
	case "asc", "desc":
		filter.Descending = value == "desc"
	default:
		return filter, fmt.Errorf("direction must be asc or desc")
	}
	if value := strings.TrimSpace(query.Get("limit")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > maxLocalWorkCleanupWorks {
			return filter, fmt.Errorf("limit must be a whole number from 1 to %d", maxLocalWorkCleanupWorks)
		}
		filter.Limit = parsed
	}
	return filter, nil
}

// sortLocalWorkCleanupCandidates orders the works by size, or by rating with
// unrated works last and larger works first within a rating. Works whose files
// have no recorded size follow the works of the same known size.
func sortLocalWorkCleanupCandidates(candidates []localWorkCleanupCandidate, order string, descending bool) {
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if order == localWorkCleanupSortRating && !sameLocalWorkCleanupRating(left.Rating, right.Rating) {
			if left.Rating == nil || right.Rating == nil {
				return right.Rating == nil
			}
			return (*left.Rating > *right.Rating) == descending
		}
		if left.SizeBytes != right.SizeBytes {
			larger := left.SizeBytes > right.SizeBytes
			if order == localWorkCleanupSortSize && !descending {
				return !larger
			}
			return larger
		}
		if (left.UnknownSizeFiles == 0) != (right.UnknownSizeFiles == 0) {
			return left.UnknownSizeFiles == 0
		}
		return left.PrimaryCode < right.PrimaryCode
	})
}

func sameLocalWorkCleanupRating(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// applyLocalWorkCleanupTitles shows each listed work under the title the
// viewer's metadata languages and manual overrides choose.
func (s *Server) applyLocalWorkCleanupTitles(ctx context.Context, works []localWorkCleanupCandidate) error {
	if len(works) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(works))
	for _, work := range works {
		ids = append(ids, work.WorkID)
	}
	titles, err := s.loadWorkTitles(ctx, ids)
	if err != nil {
		return err
	}
	for index := range works {
		if title := strings.TrimSpace(titles[works[index].WorkID].Title); title != "" {
			works[index].Title = title
		}
	}
	return nil
}

type localWorkCleanupFamilyMember struct {
	workID      int64
	familyKey   int64
	code        string
	title       string
	isCanonical bool
}

// loadLocalWorkCleanupCandidates returns one candidate per work family with an
// active local folder, carrying userID's own rating and Quick mark. A family's
// rating is the highest any of its editions has, so a high rating on one
// edition is never hidden by another.
func (s *Server) loadLocalWorkCleanupCandidates(ctx context.Context, userID int64) ([]localWorkCleanupCandidate, error) {
	members, err := s.loadLocalWorkCleanupFamilies(ctx)
	if err != nil {
		return nil, err
	}
	if len(members) == 0 {
		return []localWorkCleanupCandidate{}, nil
	}
	folders, err := s.loadLocalWorkCleanupFolders(ctx)
	if err != nil {
		return nil, err
	}
	availability, err := s.loadLibraryAvailability(ctx)
	if err != nil {
		return nil, err
	}
	sizes, err := s.loadLocalWorkCleanupSizes(ctx)
	if err != nil {
		return nil, err
	}
	states, err := s.loadLocalWorkCleanupStates(ctx, userID)
	if err != nil {
		return nil, err
	}
	sourced, err := s.loadLocalWorkCleanupSourcedWorks(ctx)
	if err != nil {
		return nil, err
	}

	byFamily := map[int64]*localWorkCleanupCandidate{}
	order := []int64{}
	displayCanonical := map[int64]bool{}
	for _, member := range members {
		candidate, exists := byFamily[member.familyKey]
		if !exists {
			candidate = &localWorkCleanupCandidate{ListeningStatus: "none", Folders: []localWorkCleanupFolder{}}
			byFamily[member.familyKey] = candidate
			order = append(order, member.familyKey)
		}
		candidate.familyWorkIDs = append(candidate.familyWorkIDs, member.workID)
		if candidate.WorkID == 0 || (member.isCanonical && !displayCanonical[member.familyKey]) {
			candidate.WorkID = member.workID
			candidate.PrimaryCode = member.code
			candidate.Title = member.title
			displayCanonical[member.familyKey] = member.isCanonical
		}
		for _, folder := range folders[member.workID] {
			folder.Online = availability.readable(folder.Path)
			folder.pool, _ = storagepool.Split(availability.mode, folder.Path)
			if !folder.Online {
				candidate.Offline = true
			}
			candidate.Folders = append(candidate.Folders, folder)
		}
		size := sizes[member.workID]
		candidate.SizeBytes += size.bytes
		candidate.FileCount += size.files
		candidate.UnknownSizeFiles += size.unknown
		if sourced[member.workID] {
			candidate.SourceAvailable = true
		}
		state, ok := states[member.workID]
		if !ok {
			continue
		}
		if state.rating != nil && (candidate.Rating == nil || *state.rating > *candidate.Rating) {
			rating := *state.rating
			candidate.Rating = &rating
		}
		if state.status != "none" && (candidate.ListeningStatus == "none" || member.workID == candidate.WorkID) {
			candidate.ListeningStatus = state.status
		}
	}
	candidates := make([]localWorkCleanupCandidate, 0, len(order))
	for _, key := range order {
		candidate := byFamily[key]
		if len(candidate.Folders) == 0 {
			continue
		}
		sort.Slice(candidate.Folders, func(i, j int) bool { return candidate.Folders[i].Path < candidate.Folders[j].Path })
		sort.Slice(candidate.familyWorkIDs, func(i, j int) bool { return candidate.familyWorkIDs[i] < candidate.familyWorkIDs[j] })
		candidates = append(candidates, *candidate)
	}
	return candidates, nil
}

// localWorkCleanupFamilyKey names a work's family: its logical work, or the
// work itself, negated so it cannot collide with a logical work id.
const localWorkCleanupFamilyKey = `COALESCE(
	edition.logical_work_id,
	(SELECT logical.id FROM logical_work AS logical WHERE logical.canonical_work_id = work.id ORDER BY logical.id LIMIT 1),
	-work.id
)`

// localWorkCleanupInFolderSQL holds for a location inside an active local
// folder of its item's work, so a work's size counts only the files the
// cleanup would delete.
const localWorkCleanupInFolderSQL = `EXISTS (
	SELECT 1
	FROM work_folder_location AS folder
	INNER JOIN file_source AS folder_source ON folder_source.id = folder.file_source_id
	WHERE folder.work_id = item.work_id
		AND folder.file_source_id = location.file_source_id
		AND folder.state = 'active'
		AND folder_source.source_type = 'local_folder'
		AND (location.path = folder.root_path OR substr(location.path, 1, length(folder.root_path) + 1) = folder.root_path || '/')
)`

func (s *Server) loadLocalWorkCleanupFamilies(ctx context.Context) ([]localWorkCleanupFamilyMember, error) {
	// Demo lists only the works it admits, like every other Demo surface.
	demoOnly := 0
	if s.cfg.IsDemo() {
		demoOnly = 1
	}
	rows, err := s.db.QueryContext(ctx, `
		WITH family AS (
			SELECT work.id AS work_id, `+localWorkCleanupFamilyKey+` AS family_key
			FROM work
			LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		),
		local_family AS (
			SELECT DISTINCT family.family_key
			FROM work_folder_location AS folder
			INNER JOIN file_source AS source ON source.id = folder.file_source_id
			INNER JOIN family ON family.work_id = folder.work_id
			WHERE folder.state = 'active' AND source.source_type = 'local_folder'
		)
		SELECT family.work_id, family.family_key, work.primary_code, work.title,
			COALESCE(edition.is_canonical, 0) <> 0
				OR EXISTS (SELECT 1 FROM logical_work AS logical WHERE logical.id = family.family_key AND logical.canonical_work_id = work.id)
		FROM family
		INNER JOIN local_family ON local_family.family_key = family.family_key
		INNER JOIN work ON work.id = family.work_id
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		WHERE ? = 0 OR (`+contentpolicy.DemoEligibleWorkSQL("work")+`)
		ORDER BY family.family_key, work.id
	`, demoOnly)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	members := []localWorkCleanupFamilyMember{}
	for rows.Next() {
		var member localWorkCleanupFamilyMember
		if err := rows.Scan(&member.workID, &member.familyKey, &member.code, &member.title, &member.isCanonical); err != nil {
			return nil, err
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (s *Server) loadLocalWorkCleanupFolders(ctx context.Context) (map[int64][]localWorkCleanupFolder, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT folder.id, folder.work_id, folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE folder.state = 'active' AND source.source_type = 'local_folder'
		ORDER BY folder.id
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	folders := map[int64][]localWorkCleanupFolder{}
	for rows.Next() {
		var folder localWorkCleanupFolder
		if err := rows.Scan(&folder.ID, &folder.workID, &folder.sourceID, &folder.Path); err != nil {
			return nil, err
		}
		if folder.Path = normalizeFolderRootPath(folder.Path); folder.Path == "" {
			continue
		}
		folders[folder.workID] = append(folders[folder.workID], folder)
	}
	return folders, rows.Err()
}

type localWorkCleanupSize struct {
	bytes   int64
	files   int
	unknown int
}

func (s *Server) loadLocalWorkCleanupSizes(ctx context.Context) (map[int64]localWorkCleanupSize, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT item.work_id, COUNT(*), COALESCE(SUM(location.size_bytes), 0),
			SUM(CASE WHEN location.size_bytes IS NULL THEN 1 ELSE 0 END)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.location_type = 'local' AND location.availability = 'available'
			AND `+localWorkCleanupInFolderSQL+`
		GROUP BY item.work_id
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	sizes := map[int64]localWorkCleanupSize{}
	for rows.Next() {
		var workID int64
		var size localWorkCleanupSize
		if err := rows.Scan(&workID, &size.files, &size.bytes, &size.unknown); err != nil {
			return nil, err
		}
		sizes[workID] = size
	}
	return sizes, rows.Err()
}

type localWorkCleanupState struct {
	rating *int
	status string
}

func (s *Server) loadLocalWorkCleanupStates(ctx context.Context, userID int64) (map[int64]localWorkCleanupState, error) {
	states := map[int64]localWorkCleanupState{}
	if userID <= 0 {
		return states, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT work_id, rating, listening_status
		FROM user_work_state
		WHERE user_id = ? AND (rating IS NOT NULL OR listening_status <> 'none')
	`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var workID int64
		var rating sql.NullInt64
		var state localWorkCleanupState
		if err := rows.Scan(&workID, &rating, &state.status); err != nil {
			return nil, err
		}
		state.rating = validUserRating(rating)
		if strings.TrimSpace(state.status) == "" {
			state.status = "none"
		}
		states[workID] = state
	}
	return states, rows.Err()
}

// loadLocalWorkCleanupSourcedWorks lists the works some source other than the
// library and the playback cache still provides. Forgetting keeps such a work,
// because the source would only bring it back.
func (s *Server) loadLocalWorkCleanupSourcedWorks(ctx context.Context) (map[int64]bool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT work_id FROM work_source_presence
		WHERE availability = 'available' AND presence_type <> 'local'
		UNION
		SELECT item.work_id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.availability = 'available' AND location.location_type NOT IN ('local', 'cache')
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	sourced := map[int64]bool{}
	for rows.Next() {
		var workID int64
		if err := rows.Scan(&workID); err != nil {
			return nil, err
		}
		sourced[workID] = true
	}
	return sourced, rows.Err()
}

type localWorkCleanupConfirmedFolder struct {
	ID   int64  `json:"id"`
	Path string `json:"path"`
}

type localWorkCleanupConfirmedWork struct {
	WorkID  int64                             `json:"workId"`
	Folders []localWorkCleanupConfirmedFolder `json:"folders"`
}

type localWorkCleanupRequest struct {
	Works            []localWorkCleanupConfirmedWork `json:"works"`
	ClearRating      bool                            `json:"clearRating"`
	ClearMark        bool                            `json:"clearMark"`
	Forget           bool                            `json:"forget"`
	ConfirmHighRated bool                            `json:"confirmHighRated"`
}

type localWorkCleanupResult struct {
	RunID  int64  `json:"runId"`
	JobID  int64  `json:"jobId"`
	Status string `json:"status"`
	Works  int    `json:"works"`
}

func (s *Server) cleanupLocalWorks(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	var request localWorkCleanupRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", false)
		return
	}
	if request.Forget {
		if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
			return
		}
	}
	result, err := s.enqueueLocalWorkCleanup(r.Context(), actor.ID, request)
	if err != nil {
		writeMediaCleanupError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// enqueueLocalWorkCleanup checks the request against the works as the list
// showed them and queues the run. Indexing and deleting happen in the run,
// while it holds the library folders.
func (s *Server) enqueueLocalWorkCleanup(ctx context.Context, actorUserID int64, request localWorkCleanupRequest) (localWorkCleanupResult, error) {
	if actorUserID <= 0 {
		return localWorkCleanupResult{}, fmt.Errorf("an authenticated actor is required to clean up local works")
	}
	if request.Forget && (!request.ClearRating || !request.ClearMark) {
		return localWorkCleanupResult{}, invalidRequestError("forgetting works also requires clearing their rating and Quick mark")
	}
	if len(request.Works) == 0 {
		return localWorkCleanupResult{}, invalidRequestError("select at least one work")
	}
	if len(request.Works) > maxLocalWorkCleanupWorks {
		return localWorkCleanupResult{}, invalidRequestError(fmt.Sprintf("at most %d works can be cleaned up at once", maxLocalWorkCleanupWorks))
	}
	candidates, err := s.loadLocalWorkCleanupCandidates(ctx, actorUserID)
	if err != nil {
		return localWorkCleanupResult{}, err
	}
	byWork := make(map[int64]localWorkCleanupCandidate, len(candidates))
	for _, candidate := range candidates {
		byWork[candidate.WorkID] = candidate
	}
	works := make([]localWorkCleanupJobWork, 0, len(request.Works))
	codes := make([]string, 0, len(request.Works))
	seen := map[int64]bool{}
	highRated := false
	for _, confirmed := range request.Works {
		if seen[confirmed.WorkID] {
			continue
		}
		seen[confirmed.WorkID] = true
		candidate, ok := byWork[confirmed.WorkID]
		if !ok {
			return localWorkCleanupResult{}, mediaCleanupTargetConflictError{message: "a selected work no longer has a local folder; refresh the list and try again"}
		}
		if candidate.Offline {
			return localWorkCleanupResult{}, mediaCleanupTargetConflictError{message: "a selected work is on an offline storage pool"}
		}
		if !localWorkCleanupFoldersMatch(candidate.Folders, confirmed.Folders) {
			return localWorkCleanupResult{}, mediaCleanupTargetConflictError{message: "the local folders of a selected work changed; refresh the list and try again"}
		}
		for _, folder := range candidate.Folders {
			if _, err := validateDestructivePath(s.cfg.DataRoot, folder.Path, true, true); err != nil {
				return localWorkCleanupResult{}, err
			}
		}
		if candidate.Rating != nil && *candidate.Rating >= localWorkCleanupHighRating {
			highRated = true
		}
		works = append(works, localWorkCleanupJobWorkFor(candidate))
		codes = append(codes, candidate.PrimaryCode)
	}
	if highRated && !request.ConfirmHighRated {
		return localWorkCleanupResult{}, &requestError{
			status: http.StatusConflict, code: localWorkCleanupHighRatingCode,
			message: "the selection includes works rated 3 stars or more; confirm deleting them",
		}
	}
	options := mediaCleanupOptions{
		Mode: mediaCleanupFilesOnly, ActorUserID: actorUserID, Works: works,
		ClearRating: request.ClearRating, ClearMark: request.ClearMark,
	}
	if request.Forget {
		options.Mode = mediaCleanupForgetWork
	}
	runID, jobID, err := s.insertMediaCleanupWorkflow(ctx, nil, options)
	if err != nil {
		return localWorkCleanupResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
		VALUES (?, ?, 'workflow_run', ?, ?)
	`, actorUserID, localWorkCleanupAuditAction, strconv.FormatInt(runID, 10), mustJSON(map[string]any{
		"codes": codes, "clearRating": request.ClearRating, "clearMark": request.ClearMark,
		"forget": request.Forget, "highRated": highRated,
	})); err != nil {
		return localWorkCleanupResult{}, err
	}
	return localWorkCleanupResult{RunID: runID, JobID: jobID, Status: "queued", Works: len(works)}, nil
}

func localWorkCleanupFoldersMatch(current []localWorkCleanupFolder, confirmed []localWorkCleanupConfirmedFolder) bool {
	if len(current) != len(confirmed) {
		return false
	}
	paths := make(map[int64]string, len(current))
	for _, folder := range current {
		paths[folder.ID] = folder.Path
	}
	for _, folder := range confirmed {
		path, ok := paths[folder.ID]
		if !ok || path != normalizeFolderRootPath(folder.Path) {
			return false
		}
		delete(paths, folder.ID)
	}
	return len(paths) == 0
}
