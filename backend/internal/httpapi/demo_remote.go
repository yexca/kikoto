package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"math/rand/v2"
	"net/http"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

// Demo has no real remote server. It publishes one simulated
// Kikoeru-compatible source whose catalog is a random selection of the admitted
// local works, and answers that source's requests in process. The source uses
// the ordinary source type so every remote surface runs its normal code path.
const (
	demoRemoteSourceCode        = "demo_remote_kikoeru"
	demoRemoteSourceDisplayName = "Remote Kikoeru"
	demoRemoteSourceHost        = "remote-kikoeru.invalid"
	demoRemoteSourceURL         = "https://" + demoRemoteSourceHost
	demoRemoteCatalogMaxWorks   = 24
	demoRemoteTrackedMaxWorks   = 4
	demoRemotePageSizeMax       = 100
)

// legacyDemoShowcaseSourceCode names the disabled Example Track source that
// the simulated remote source replaces.
const legacyDemoShowcaseSourceCode = "demo_showcase"

var errDemoRemoteHost = errors.New("demo mode only answers its simulated remote source")

// seedDemoRemoteSource replaces every configured remote source with the
// simulated one and draws a new random catalog from the admitted local works.
// It returns the catalog in its random order.
func (s *Server) seedDemoRemoteSource(ctx context.Context, tx *sql.Tx) ([]demoShowcaseWork, error) {
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM file_source
		WHERE code = ?
			OR (code <> ? AND source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178', 'kikoeru_compilable_number178'))
	`, legacyDemoShowcaseSourceCode, demoRemoteSourceCode); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES (?, ?, ?, 30, 1, '{}')
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name,
			source_type = excluded.source_type, enabled = 1
	`, demoRemoteSourceCode, demoRemoteSourceDisplayName, sourceTypeKikoeruCompatible); err != nil {
		return nil, err
	}
	var sourceID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM file_source WHERE code = ?", demoRemoteSourceCode).Scan(&sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM file_source_endpoint WHERE file_source_id = ?", sourceID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, health_status, last_checked_at)
		VALUES (?, ?, ?, 'healthy', CURRENT_TIMESTAMP)
	`, sourceID, demoRemoteSourceURL, demoRemoteSourceURL); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_source_presence WHERE file_source_id = ?", sourceID); err != nil {
		return nil, err
	}

	candidates, err := demoAdmittedLocalWorks(ctx, tx)
	if err != nil {
		return nil, err
	}
	rand.Shuffle(len(candidates), func(i, j int) { candidates[i], candidates[j] = candidates[j], candidates[i] })
	catalogSize := min((len(candidates)+1)/2, demoRemoteCatalogMaxWorks)
	catalog := candidates[:catalogSize]
	inCatalog := map[int64]bool{}
	for _, work := range catalog {
		inCatalog[work.id] = true
	}
	for _, candidate := range candidates {
		var title string
		if err := tx.QueryRowContext(ctx, "SELECT title FROM work WHERE id = ?", candidate.id).Scan(&title); err != nil {
			return nil, err
		}
		status, availability := "not_found", "missing"
		if inCatalog[candidate.id] {
			status, availability = "available", "available"
		}
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID: candidate.id, FileSourceID: sourceID, PresenceType: sourcePresenceTypeRemoteSource,
			RemoteID: strconv.FormatInt(candidate.id, 10), RemoteCode: candidate.code, Availability: availability,
			RawJSON: mustJSON(map[string]any{
				"status": status, "primary_code": candidate.code, "title": title,
			}),
		}); err != nil {
			return nil, err
		}
	}
	for _, work := range catalog[:min(len(catalog), demoRemoteTrackedMaxWorks)] {
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID: work.id, FileSourceID: sourceID, PresenceType: "tracked",
			RemoteID: strconv.FormatInt(work.id, 10), RemoteCode: work.code, Availability: "available",
		}); err != nil {
			return nil, err
		}
	}
	return catalog, nil
}

// demoAdmittedLocalWorks lists the admitted local works the Library shows; a
// language edition folded into its original work is not a separate catalog entry.
func demoAdmittedLocalWorks(ctx context.Context, tx *sql.Tx) ([]demoShowcaseWork, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT work.id, work.primary_code FROM work
		WHERE `+contentpolicy.DemoEligibleWorkSQL("work")+`
			AND `+demoLibraryVisibilityPredicateSQL+`
			AND EXISTS (SELECT 1 FROM work_source_presence AS presence
				INNER JOIN file_source AS source ON source.id = presence.file_source_id
				WHERE presence.work_id = work.id AND presence.presence_type = 'local'
					AND presence.availability = 'available' AND source.source_type = 'local_folder')
		ORDER BY work.primary_code
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	works := []demoShowcaseWork{}
	for rows.Next() {
		var work demoShowcaseWork
		if err := rows.Scan(&work.id, &work.code); err != nil {
			return nil, err
		}
		works = append(works, work)
	}
	return works, rows.Err()
}

// demoRemoteHTTPClient replaces every source client in Demo. Its transport
// serves only the simulated source and never opens a network connection.
func (s *Server) demoRemoteHTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Transport: demoRemoteTransport{handler: s.demoRemoteHandler()},
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (s *Server) demoRemoteHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "OK")
	})
	mux.HandleFunc("GET /api/works", s.serveDemoRemoteWorks)
	mux.HandleFunc("GET /api/search/{keyword}", s.serveDemoRemoteWorks)
	mux.HandleFunc("POST /api/recommender/popular", s.serveDemoRemotePopular)
	mux.HandleFunc("GET /api/workInfo/{code}", s.serveDemoRemoteWorkInfo)
	mux.HandleFunc("GET /api/tracks/{id}", s.serveDemoRemoteTracks)
	mux.HandleFunc("GET /media/{location}", s.serveDemoRemoteMedia)
	return mux
}

// demoRemoteSourceID returns the simulated source, or zero before Demo seeded it.
func (s *Server) demoRemoteSourceID(ctx context.Context) (int64, error) {
	var sourceID int64
	err := s.db.QueryRowContext(ctx, "SELECT id FROM file_source WHERE code = ? AND enabled = 1", demoRemoteSourceCode).Scan(&sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return sourceID, err
}

func (s *Server) demoRemoteCatalog(ctx context.Context) ([]kikoeru.Work, error) {
	sourceID, err := s.demoRemoteSourceID(ctx)
	if err != nil || sourceID == 0 {
		return []kikoeru.Work{}, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE presence.file_source_id = ? AND presence.presence_type = ? AND presence.availability = 'available'
			AND `+contentpolicy.DemoEligibleWorkSQL("work")+`
			AND `+demoLibraryVisibilityPredicateSQL+`
		ORDER BY work.id
		LIMIT ?
	`, sourceID, sourcePresenceTypeRemoteSource, demoRemotePageSizeMax)
	if err != nil {
		return nil, err
	}
	ids := []any{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return []kikoeru.Work{}, nil
	}
	where := "work.id IN (?" + strings.Repeat(", ?", len(ids)-1) + ")"
	raw, err := s.libraryStore.ListMatching(ctx, 0, where, ids, 1, len(ids), true)
	if err != nil {
		return nil, err
	}
	summaries, err := s.scanLibraryWorkRows(ctx, 0, raw, false)
	if err != nil {
		return nil, err
	}
	works := make([]kikoeru.Work, 0, len(summaries))
	for _, summary := range summaries {
		works = append(works, demoRemoteWork(summary))
	}
	return works, nil
}

func demoRemoteWork(summary libraryWorkSummary) kikoeru.Work {
	work := kikoeru.Work{
		ID: summary.ID, Title: summary.Title, SourceID: summary.PrimaryCode, SourceType: "DLSITE",
		SourceURL: summary.DLsiteURL, AgeCategoryString: summary.AgeRating,
		MainCoverURL: summary.CoverURL, SamCoverURL: summary.CoverURL, ThumbnailCoverURL: summary.CoverURL,
		RateAverage2DP: summary.Rating, ReviewCount: summary.RatingCount, DLCount: summary.Sales,
		Price: summary.Price, Tags: []kikoeru.Tag{}, VAs: []kikoeru.VA{},
	}
	if summary.ReleaseDate != nil {
		work.Release = *summary.ReleaseDate
	}
	if circle := strings.TrimSpace(summary.Circle); circle != "" {
		work.Circle = &kikoeru.Circle{ID: demoRemoteEntityID(circle), Name: circle}
	}
	for _, tag := range summary.Tags {
		work.Tags = append(work.Tags, kikoeru.Tag{ID: demoRemoteEntityID(tag), Name: tag})
	}
	for _, voice := range summary.VoiceActors {
		work.VAs = append(work.VAs, kikoeru.VA{ID: strconv.FormatInt(demoRemoteEntityID(voice), 10), Name: voice})
	}
	return work
}

// demoRemoteEntityID gives a simulated circle, tag, or voice a stable remote id.
func demoRemoteEntityID(name string) int64 {
	hash := fnv.New32a()
	_, _ = hash.Write([]byte(strings.ToLower(name)))
	return int64(hash.Sum32()) + 1
}

func (s *Server) serveDemoRemoteWorks(w http.ResponseWriter, r *http.Request) {
	catalog, err := s.demoRemoteCatalog(r.Context())
	if err != nil {
		http.Error(w, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	query := r.URL.Query()
	works := filterDemoRemoteWorks(catalog, r.PathValue("keyword"))
	sortDemoRemoteWorks(works, query.Get("order"), query.Get("sort"), query.Get("seed"))
	writeDemoRemotePage(w, works, queryInt(r, "page", 1), queryInt(r, "pageSize", 20))
}

func (s *Server) serveDemoRemotePopular(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Page     int `json:"page"`
		PageSize int `json:"pageSize"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&payload)
	catalog, err := s.demoRemoteCatalog(r.Context())
	if err != nil {
		http.Error(w, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	sortDemoRemoteWorks(catalog, "dl_count", "desc", "")
	writeDemoRemotePage(w, catalog, payload.Page, payload.PageSize)
}

func writeDemoRemotePage(w http.ResponseWriter, works []kikoeru.Work, page int, pageSize int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > demoRemotePageSizeMax {
		pageSize = demoRemotePageSizeMax
	}
	start := min((page-1)*pageSize, len(works))
	end := min(start+pageSize, len(works))
	writeJSON(w, http.StatusOK, kikoeru.WorksPage{
		Works:      works[start:end],
		Pagination: kikoeru.Pagination{CurrentPage: page, PageSize: pageSize, TotalCount: len(works)},
	})
}

var demoRemoteFilterPattern = regexp.MustCompile(`\$(-?)([a-z]+):([^$]*)\$`)

// filterDemoRemoteWorks applies the search filters a Kikoeru server would.
// Filters it does not model match every work.
func filterDemoRemoteWorks(catalog []kikoeru.Work, keyword string) []kikoeru.Work {
	filters := demoRemoteFilterPattern.FindAllStringSubmatch(keyword, -1)
	terms := strings.Fields(strings.ToLower(demoRemoteFilterPattern.ReplaceAllString(keyword, " ")))
	works := make([]kikoeru.Work, 0, len(catalog))
	for _, work := range catalog {
		matched := true
		for _, filter := range filters {
			if demoRemoteFilterMatches(work, filter[2], strings.ToLower(strings.TrimSpace(filter[3]))) == (filter[1] == "-") {
				matched = false
				break
			}
		}
		for _, term := range terms {
			if !matched {
				break
			}
			matched = demoRemoteTextMatches(work, term)
		}
		if matched {
			works = append(works, work)
		}
	}
	return works
}

func demoRemoteFilterMatches(work kikoeru.Work, name string, value string) bool {
	contains := func(candidate string) bool { return strings.Contains(strings.ToLower(candidate), value) }
	atLeast := func(actual *float64) bool {
		limit, err := strconv.ParseFloat(value, 64)
		return err != nil || actual != nil && *actual >= limit
	}
	switch name {
	case "circle":
		return work.Circle != nil && contains(work.Circle.Name)
	case "va":
		for _, voice := range work.VAs {
			if contains(voice.Name) {
				return true
			}
		}
		return false
	case "tag":
		for _, tag := range work.Tags {
			if contains(tag.Name) {
				return true
			}
		}
		return false
	case "age":
		return strings.EqualFold(strings.TrimSpace(work.AgeCategoryString), value)
	case "rate":
		return atLeast(work.RateAverage2DP)
	case "sell":
		var sales *float64
		if work.DLCount != nil {
			value := float64(*work.DLCount)
			sales = &value
		}
		return atLeast(sales)
	default:
		return true
	}
}

func demoRemoteTextMatches(work kikoeru.Work, term string) bool {
	values := []string{work.SourceID, work.Title}
	if work.Circle != nil {
		values = append(values, work.Circle.Name)
	}
	for _, tag := range work.Tags {
		values = append(values, tag.Name)
	}
	for _, voice := range work.VAs {
		values = append(values, voice.Name)
	}
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), term) {
			return true
		}
	}
	return false
}

func sortDemoRemoteWorks(works []kikoeru.Work, order string, direction string, seed string) {
	if order == "random" {
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(seed))
		random := rand.New(rand.NewPCG(hash.Sum64(), 0))
		sort.Slice(works, func(i, j int) bool { return works[i].ID < works[j].ID })
		random.Shuffle(len(works), func(i, j int) { works[i], works[j] = works[j], works[i] })
		return
	}
	float := func(value *float64) float64 {
		if value == nil {
			return -1
		}
		return *value
	}
	count := func(value *int64) int64 {
		if value == nil {
			return -1
		}
		return *value
	}
	compare := func(left, right kikoeru.Work) int {
		switch order {
		case "release", "create_date":
			return strings.Compare(left.Release, right.Release)
		case "rate_average_2dp":
			return compareOrdered(float(left.RateAverage2DP), float(right.RateAverage2DP))
		case "dl_count":
			return compareOrdered(count(left.DLCount), count(right.DLCount))
		default:
			return strings.Compare(left.SourceID, right.SourceID)
		}
	}
	descending := !strings.EqualFold(direction, "asc")
	sort.SliceStable(works, func(i, j int) bool {
		result := compare(works[i], works[j])
		if result == 0 {
			result = compareOrdered(works[i].ID, works[j].ID)
		}
		if descending {
			return result > 0
		}
		return result < 0
	})
}

func compareOrdered[T int64 | float64](left, right T) int {
	switch {
	case left < right:
		return -1
	case left > right:
		return 1
	default:
		return 0
	}
}

func (s *Server) demoRemoteCatalogWork(ctx context.Context, matches func(kikoeru.Work) bool) (kikoeru.Work, bool, error) {
	catalog, err := s.demoRemoteCatalog(ctx)
	if err != nil {
		return kikoeru.Work{}, false, err
	}
	for _, work := range catalog {
		if matches(work) {
			return work, true, nil
		}
	}
	return kikoeru.Work{}, false, nil
}

func (s *Server) serveDemoRemoteWorkInfo(w http.ResponseWriter, r *http.Request) {
	requested := strings.TrimSpace(r.PathValue("code"))
	work, found, err := s.demoRemoteCatalogWork(r.Context(), func(work kikoeru.Work) bool {
		return strings.EqualFold(work.SourceID, requested) || strconv.FormatInt(work.ID, 10) == requested
	})
	if err != nil {
		http.Error(w, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	if !found {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, work)
}

type demoRemoteFile struct {
	locationID int64
	path       string
	kind       string
	size       int64
	duration   float64
}

func (s *Server) serveDemoRemoteTracks(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	_, found, err := s.demoRemoteCatalogWork(r.Context(), func(work kikoeru.Work) bool { return work.ID == id })
	if err != nil {
		http.Error(w, "catalog unavailable", http.StatusInternalServerError)
		return
	}
	if !found {
		http.NotFound(w, r)
		return
	}
	files, err := s.demoRemoteWorkFiles(r.Context(), id)
	if err != nil {
		http.Error(w, "tracks unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, demoRemoteTrackTree(files))
}

// demoRemoteWorkFiles lists the work's available local files relative to its
// local folder, which becomes the simulated remote directory.
func (s *Server) demoRemoteWorkFiles(ctx context.Context, workID int64) ([]demoRemoteFile, error) {
	var folder string
	err := s.db.QueryRowContext(ctx, `
		SELECT presence.source_url FROM work_source_presence AS presence
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE presence.work_id = ? AND presence.presence_type = 'local'
			AND presence.availability = 'available' AND source.source_type = 'local_folder'
		ORDER BY presence.file_source_id LIMIT 1
	`, workID).Scan(&folder)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	folder = strings.Trim(strings.ReplaceAll(folder, `\`, "/"), "/")
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.path, item.kind,
			COALESCE(location.size_bytes, item.size_bytes, 0),
			COALESCE(location.duration_seconds, item.duration_seconds, 0)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
		ORDER BY location.path
	`, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	files := []demoRemoteFile{}
	for rows.Next() {
		var file demoRemoteFile
		if err := rows.Scan(&file.locationID, &file.path, &file.kind, &file.size, &file.duration); err != nil {
			return nil, err
		}
		file.path = strings.Trim(strings.ReplaceAll(file.path, `\`, "/"), "/")
		if folder != "" {
			relative, ok := strings.CutPrefix(file.path, folder+"/")
			if !ok {
				continue
			}
			file.path = relative
		}
		files = append(files, file)
	}
	return files, rows.Err()
}

func demoRemoteTrackTree(files []demoRemoteFile) []kikoeru.Track {
	type folderNode struct {
		track    kikoeru.Track
		children []*folderNode
		files    []kikoeru.Track
		byName   map[string]*folderNode
	}
	root := &folderNode{byName: map[string]*folderNode{}}
	for _, file := range files {
		segments := strings.Split(file.path, "/")
		parent := root
		for _, name := range segments[:len(segments)-1] {
			child := parent.byName[name]
			if child == nil {
				child = &folderNode{track: kikoeru.Track{Type: "folder", Title: name}, byName: map[string]*folderNode{}}
				parent.byName[name] = child
				parent.children = append(parent.children, child)
			}
			parent = child
		}
		mediaURL := "/media/" + strconv.FormatInt(file.locationID, 10)
		parent.files = append(parent.files, kikoeru.Track{
			Type: demoRemoteTrackType(file.kind, file.path), Title: path.Base(file.path),
			Hash:           fmt.Sprintf("demo-%d", file.locationID),
			MediaStreamURL: mediaURL, MediaDownloadURL: mediaURL,
			Duration: file.duration, Size: file.size,
		})
	}
	var build func(node *folderNode) []kikoeru.Track
	build = func(node *folderNode) []kikoeru.Track {
		tracks := make([]kikoeru.Track, 0, len(node.children)+len(node.files))
		for _, child := range node.children {
			folder := child.track
			folder.Children = build(child)
			tracks = append(tracks, folder)
		}
		return append(tracks, node.files...)
	}
	return build(root)
}

func demoRemoteTrackType(kind string, filePath string) string {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "audio", "video", "text", "image":
		return strings.ToLower(strings.TrimSpace(kind))
	default:
		return mediaKindFromPath(filePath)
	}
}

func (s *Server) serveDemoRemoteMedia(w http.ResponseWriter, r *http.Request) {
	locationID, err := strconv.ParseInt(r.PathValue("location"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	sourceID, err := s.demoRemoteSourceID(r.Context())
	if err != nil || sourceID == 0 {
		http.NotFound(w, r)
		return
	}
	var relativePath string
	err = s.db.QueryRowContext(r.Context(), `
		SELECT location.path FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work_source_presence AS presence ON presence.work_id = item.work_id
			AND presence.file_source_id = ? AND presence.presence_type = ? AND presence.availability = 'available'
		WHERE location.id = ? AND location.location_type = 'local' AND location.availability = 'available'
	`, sourceID, sourcePresenceTypeRemoteSource, locationID).Scan(&relativePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	filePath, err := safeDataPath(s.cfg.DataRoot, relativePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

// demoRemoteTransport hands a request for the simulated source to its handler
// and streams the handler's response back through a pipe, so large media is
// never buffered. Every other destination fails before any I/O.
type demoRemoteTransport struct {
	handler http.Handler
}

func (transport demoRemoteTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL == nil || request.URL.Scheme != "https" || request.URL.User != nil ||
		!strings.EqualFold(request.URL.Host, demoRemoteSourceHost) {
		if request.Body != nil {
			_ = request.Body.Close()
		}
		return nil, errDemoRemoteHost
	}
	reader, writer := io.Pipe()
	response := &demoRemoteResponseWriter{header: http.Header{}, body: writer, ready: make(chan struct{})}
	go func() {
		defer func() {
			response.WriteHeader(http.StatusOK)
			_ = writer.Close()
			if request.Body != nil {
				_ = request.Body.Close()
			}
		}()
		transport.handler.ServeHTTP(response, request)
	}()
	select {
	case <-response.ready:
	case <-request.Context().Done():
		_ = reader.CloseWithError(request.Context().Err())
		return nil, request.Context().Err()
	}
	contentLength := int64(-1)
	if value, err := strconv.ParseInt(response.sent.Get("Content-Length"), 10, 64); err == nil {
		contentLength = value
	}
	return &http.Response{
		Status: fmt.Sprintf("%d %s", response.status, http.StatusText(response.status)), StatusCode: response.status,
		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: response.sent, Body: reader, ContentLength: contentLength, Request: request,
	}, nil
}

type demoRemoteResponseWriter struct {
	header http.Header
	sent   http.Header
	status int
	body   *io.PipeWriter
	once   sync.Once
	ready  chan struct{}
}

func (writer *demoRemoteResponseWriter) Header() http.Header { return writer.header }

func (writer *demoRemoteResponseWriter) WriteHeader(status int) {
	writer.once.Do(func() {
		writer.status = status
		writer.sent = writer.header.Clone()
		close(writer.ready)
	})
}

func (writer *demoRemoteResponseWriter) Write(data []byte) (int, error) {
	writer.WriteHeader(http.StatusOK)
	return writer.body.Write(data)
}
