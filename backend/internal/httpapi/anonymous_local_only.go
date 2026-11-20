package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/library"
)

// While anonymous remote-source browsing is off, a visitor without an account
// reaches local content only: works with a local folder and the files of local
// folder locations. Everything remote-derived needs an account: remote source
// catalogs and listings, remote and cache streams, remote-only works, and the
// remote availability and source names on local works.

type localOnlyKey struct{}

func withLocalOnly(ctx context.Context) context.Context {
	return context.WithValue(ctx, localOnlyKey{}, true)
}

// localOnlyRequest reports a request limited to local content.
func localOnlyRequest(ctx context.Context) bool {
	limited, _ := ctx.Value(localOnlyKey{}).(bool)
	return limited
}

// localOnlyRefusedPath reports a route that only serves remote-derived
// content: remote source catalogs and listings, a voice actor's remote
// matches, a work's source availability, and remote Track runs.
func localOnlyRefusedPath(path string) bool {
	switch {
	case strings.HasPrefix(path, "/api/remote-sources/"),
		strings.HasPrefix(path, "/api/remote-track-runs/"),
		path == "/api/library-sources":
		return true
	case strings.HasPrefix(path, "/api/voices/") && strings.HasSuffix(strings.TrimSuffix(path, "/"), "/remote-matches"):
		return true
	case strings.HasPrefix(path, "/api/works/") && strings.HasSuffix(strings.TrimSuffix(path, "/"), "/source-availability"):
		return true
	}
	return false
}

// mediaLocationOfPath returns the location id of a /api/media/{id}/... path.
func mediaLocationOfPath(path string) (int64, bool) {
	rest, ok := strings.CutPrefix(path, "/api/media/")
	if !ok {
		return 0, false
	}
	idText, _, _ := strings.Cut(rest, "/")
	id, err := strconv.ParseInt(idText, 10, 64)
	return id, err == nil && id > 0
}

// localOnlyMediaRefused reports a media request whose location is not a local
// folder file, such as a remote stream or a cache file.
func (s *Server) localOnlyMediaRefused(r *http.Request) (bool, error) {
	locationID, ok := mediaLocationOfPath(r.URL.Path)
	if !ok {
		return false, nil
	}
	var locationType string
	err := s.db.QueryRowContext(r.Context(), `SELECT location_type FROM media_file_location WHERE id = ?`, locationID).Scan(&locationType)
	if err != nil {
		// A missing location answers as it does for everyone.
		return false, nil
	}
	return locationType != "local", nil
}

// workFamilyHasLocalFolder reports whether the work, or another edition of its
// family, has an available local folder.
func (s *Server) workFamilyHasLocalFolder(ctx context.Context, workID int64) (bool, error) {
	var local bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM work WHERE work.id = ? AND `+library.LocalPresencePredicateSQL()+`)`, workID).Scan(&local)
	return local, err
}

// refuseRemoteOnlyWork answers 401 for a work without a local folder when the
// request is limited to local content, and reports whether it did.
func (s *Server) refuseRemoteOnlyWork(w http.ResponseWriter, r *http.Request, workID int64) bool {
	if !localOnlyRequest(r.Context()) {
		return false
	}
	local, err := s.workFamilyHasLocalFolder(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return true
	}
	if !local {
		writeAPIError(w, http.StatusUnauthorized, "authentication_required", "sign in to browse remote sources", false)
		return true
	}
	return false
}

func localSourceStats(tags []circleSourceStat) []circleSourceStat {
	kept := make([]circleSourceStat, 0, len(tags))
	for _, tag := range tags {
		if tag.Key == "local" {
			kept = append(kept, tag)
		}
	}
	return kept
}

func localSourcePresence(items []sourcePresenceItem) []sourcePresenceItem {
	kept := make([]sourcePresenceItem, 0, len(items))
	for _, item := range items {
		if item.Type == "local" {
			kept = append(kept, item)
		}
	}
	return kept
}

func localMediaLocations(items []mediaItemDetail) {
	for index := range items {
		kept := make([]fileLocationDetail, 0, len(items[index].Locations))
		for _, location := range items[index].Locations {
			if location.LocationType == "local" {
				kept = append(kept, location)
			}
		}
		items[index].Locations = kept
	}
}

func localVoiceKnownWork(work *voiceKnownWork) {
	work.Remote, work.Cache = false, false
	work.RemoteObservations = []voiceRemoteObservation{}
	work.SourceTags = localSourceStats(work.SourceTags)
}

func localCircleWork(work *circleCatalogWork) {
	work.Remote = false
	work.SourceTags = localSourceStats(work.SourceTags)
}
