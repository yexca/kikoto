package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/record"
)

// recordProgressOrderSkew bounds how far ahead of the server a client's
// progress order may be.
const recordProgressOrderSkew = 5 * time.Minute

// recordProgressOrder is the order a progress save is stored under. An order
// more than recordProgressOrderSkew ahead of the server comes from a clock
// running fast and would hold the file's progress until the server caught
// up; such a save is ordered by when the server receives it.
func recordProgressOrder(order int64, now time.Time) int64 {
	if order > now.Add(recordProgressOrderSkew).UnixMilli() {
		return now.UnixMilli()
	}
	return order
}

func parseRecordID(r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	return id, err == nil && id > 0
}

func (s *Server) getRecordRoot(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	root, err := s.recordStore.EnsureRoot(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "record_root_unavailable", "The record library is unavailable.", true)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"root": root})
}

// decorateRecordFolder names the URLs of the artwork a scan chose for the
// folder.
func decorateRecordFolder(folder *record.Folder) {
	id := strconv.FormatInt(folder.ID, 10)
	if folder.HasPoster {
		folder.Artwork.PosterURL = "/api/records/folders/" + id + "/artwork/poster"
	}
	if folder.HasBackdrop {
		folder.Artwork.BackdropURL = "/api/records/folders/" + id + "/artwork/backdrop"
	}
}

// listRecordTree lists a folder, the root without folderId. Without section
// it answers the folder's trail and the first page of every section; with
// section it answers the page of that section after the cursor in after.
func (s *Server) listRecordTree(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	query := r.URL.Query()
	parent := int64(0)
	if value := strings.TrimSpace(query.Get("folderId")); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed <= 0 {
			writeAPIError(w, http.StatusBadRequest, "invalid_folder_id", "Invalid record folder.", false)
			return
		}
		parent = parsed
	}
	section := strings.TrimSpace(query.Get("section"))
	if section == "" {
		view, err := s.recordStore.FolderView(r.Context(), parent, record.SectionPageMax, user.ID)
		if err != nil {
			writeAPIError(w, http.StatusInternalServerError, "record_tree_failed", "The record directory could not be read.", true)
			return
		}
		for i := range view.Trail {
			decorateRecordFolder(&view.Trail[i])
		}
		sections := map[string]any{}
		var videos []record.Asset
		for _, page := range view.Sections {
			sections[page.Section] = recordSectionJSON(page)
			if page.Section == record.SectionVideos {
				videos = page.Assets
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"folderId": parent, "trail": view.Trail, "sections": sections})
		s.prefetchRecordVideoKeyframes(videos)
		return
	}
	page, err := s.recordStore.ListSection(r.Context(), parent, section, strings.TrimSpace(query.Get("after")), record.SectionPageMax, user.ID)
	switch {
	case errors.Is(err, record.ErrUnknownSection):
		writeAPIError(w, http.StatusBadRequest, "invalid_record_section", "Invalid record section.", false)
		return
	case errors.Is(err, record.ErrInvalidCursor):
		writeAPIError(w, http.StatusBadRequest, "invalid_record_cursor", "Invalid record listing cursor.", false)
		return
	case err != nil:
		writeAPIError(w, http.StatusInternalServerError, "record_tree_failed", "The record directory could not be read.", true)
		return
	}
	response := recordSectionJSON(page)
	response["folderId"] = parent
	response["section"] = section
	writeJSON(w, http.StatusOK, response)
	if section == record.SectionVideos {
		s.prefetchRecordVideoKeyframes(page.Assets)
	}
}

// recordSectionJSON is one section page: its items, the section's total, and
// the cursor of the next page while there is one.
func recordSectionJSON(page record.SectionPage) map[string]any {
	var items any
	if page.Section == record.SectionFolders {
		for i := range page.Folders {
			decorateRecordFolder(&page.Folders[i])
		}
		items = page.Folders
	} else {
		for i := range page.Assets {
			decorateRecordAsset(&page.Assets[i])
		}
		items = page.Assets
	}
	response := map[string]any{"items": items, "total": page.Total}
	if page.Next != "" {
		response["next"] = page.Next
	}
	return response
}

// getRecordAssetSiblings places a video, photo, or audio file in its section
// of its folder, for the viewer's position, count, and previous and next
// files.
func (s *Server) getRecordAssetSiblings(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	siblings, err := s.recordStore.AssetSiblings(r.Context(), id, user.ID)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_asset_failed", "The record asset could not be read.", true)
		return
	}
	decorateRecordAsset(&siblings.Asset)
	response := map[string]any{"asset": siblings.Asset, "section": siblings.Section, "index": siblings.Index, "total": siblings.Total}
	if siblings.Previous != nil {
		decorateRecordAsset(siblings.Previous)
		response["previous"] = siblings.Previous
	}
	if siblings.Next != nil {
		decorateRecordAsset(siblings.Next)
		response["next"] = siblings.Next
	}
	writeJSON(w, http.StatusOK, response)
}

// initializeRecordRoot initializes the record root. A root whose marker does
// not name the catalog the database keeps is refused with
// record_fresh_initialization_required unless the body asks for a fresh
// catalog, which forgets the earlier one.
func (s *Server) initializeRecordRoot(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var input struct {
		Fresh bool `json:"fresh"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&input); err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid_record_initialization", "Invalid record initialization.", false)
			return
		}
	}
	root, err := s.recordStore.InitializeRoot(r.Context(), input.Fresh)
	if errors.Is(err, record.ErrRootFreshRequired) {
		writeAPIError(w, http.StatusConflict, "record_fresh_initialization_required", "The record root does not carry the marker of the kept catalog. Restore the marker to keep the catalog, or start a new catalog.", false)
		return
	}
	if errors.Is(err, record.ErrRootPathMissing) {
		writeAPIError(w, http.StatusConflict, "record_root_path_missing", "The record root folder is missing. Mount its disk before starting a new catalog.", false)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusConflict, "record_root_initialization_failed", "The record library could not be initialized.", false)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"root": root})
}

// restoreRecordMarker writes the marker of the catalog the database keeps
// into a root that lost it.
func (s *Server) restoreRecordMarker(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	root, err := s.recordStore.RestoreMarker(r.Context())
	if errors.Is(err, record.ErrRootNotRecognized) {
		writeAPIError(w, http.StatusConflict, "record_root_not_recognized", "None of the catalog's folders or files is on the record root. Mount the disk, then restore the marker.", false)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusConflict, "record_marker_restore_failed", "The record root marker could not be restored.", false)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"root": root})
}

func (s *Server) getRecordAsset(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	a, err := s.recordStore.Asset(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_asset_failed", "The record asset could not be read.", true)
		return
	}
	decorateRecordAsset(&a)
	writeJSON(w, http.StatusOK, map[string]any{"asset": a})
}

func (s *Server) streamRecordAsset(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	path, asset, err := s.recordStore.AssetPath(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	}
	if err != nil || (asset.Kind != "video" && asset.Kind != "audio" && asset.Kind != "image") || asset.Availability != "available" {
		writeAPIError(w, http.StatusNotFound, "record_media_unavailable", "The record media is unavailable.", false)
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		writeAPIError(w, http.StatusNotFound, "record_media_unavailable", "The record media is unavailable.", false)
		return
	}
	if asset.Kind == "image" {
		if err := record.ValidateImageFile(path, asset.MimeType); err != nil {
			writeAPIError(w, http.StatusNotFound, "record_media_unavailable", "The record media is unavailable.", false)
			return
		}
	}
	// The type comes from the file's extension, never from sniffing its bytes,
	// and the response cannot run as a page: a file in the record root is
	// untrusted.
	contentType := asset.MimeType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	setUntrustedFileHeaders(w)
	if err := record.ServeContent(w, r, path, info.ModTime()); err != nil {
		writeAPIError(w, http.StatusNotFound, "record_media_unavailable", "The record media is unavailable.", false)
	}
}

func (s *Server) serveRecordArtwork(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_folder_id", "Invalid record folder.", false)
		return
	}
	path, asset, err := s.recordStore.ArtworkPath(r.Context(), id, r.PathValue("role"))
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_artwork_not_found", "Record artwork was not found.", false)
		return
	}
	if err != nil || asset.Kind != "image" {
		writeAPIError(w, http.StatusNotFound, "record_artwork_not_found", "Record artwork was not found.", false)
		return
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		writeAPIError(w, http.StatusNotFound, "record_artwork_not_found", "Record artwork was not found.", false)
		return
	}
	if err := record.ValidateImageFile(path, asset.MimeType); err != nil {
		writeAPIError(w, http.StatusNotFound, "record_artwork_not_found", "Record artwork was not found.", false)
		return
	}
	if asset.MimeType != "" {
		w.Header().Set("Content-Type", asset.MimeType)
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if err := record.ServeContent(w, r, path, info.ModTime()); err != nil {
		writeAPIError(w, http.StatusNotFound, "record_artwork_not_found", "Record artwork was not found.", false)
	}
}

func (s *Server) scanRecords(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	root, err := s.recordStore.EnsureRoot(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "record_root_unavailable", "The record library is unavailable.", true)
		return
	}
	if root.State != "online" && root.State != record.RootStateMarkerMissing {
		writeAPIError(w, http.StatusConflict, "record_root_unavailable", "Initialize and mount the record library before scanning.", false)
		return
	}
	result, err := s.enqueueRecordScan(r.Context(), user.ID)
	if err != nil {
		writeAPIError(w, http.StatusServiceUnavailable, "record_scan_failed", "The record library scan could not be queued.", true)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) getRecordProgress(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	asset, err := s.recordStore.Asset(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_asset_failed", "The record asset could not be read.", true)
		return
	}
	if asset.Kind != "video" && asset.Kind != "audio" {
		writeAPIError(w, http.StatusBadRequest, "record_progress_not_supported", "Progress is supported for videos and audio only.", false)
		return
	}
	p, err := s.recordStore.Progress(r.Context(), user.ID, id)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_progress_failed", "The record progress could not be read.", true)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) updateRecordProgress(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	asset, err := s.recordStore.Asset(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_asset_failed", "The record asset could not be read.", true)
		return
	}
	if asset.Kind != "video" && asset.Kind != "audio" {
		writeAPIError(w, http.StatusBadRequest, "record_progress_not_supported", "Progress is supported for videos and audio only.", false)
		return
	}
	var input struct {
		PositionSeconds float64  `json:"positionSeconds"`
		DurationSeconds *float64 `json:"durationSeconds"`
		Completed       bool     `json:"completed"`
		// Order is the client's capture order in Unix milliseconds.
		Order int64 `json:"order"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input); err != nil || input.PositionSeconds < 0 || input.Order <= 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_record_progress", "Invalid record progress.", false)
		return
	}
	order := recordProgressOrder(input.Order, time.Now())
	stored, err := s.recordStore.SaveProgress(r.Context(), user.ID, id, record.Progress{PositionSeconds: input.PositionSeconds, DurationSeconds: input.DurationSeconds, Completed: input.Completed, Order: order})
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_progress_failed", "The record progress could not be saved.", true)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stored": stored})
}
