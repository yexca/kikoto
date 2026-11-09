package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/record"
)

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

func (s *Server) listRecordTree(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	parent := int64(0)
	if value := strings.TrimSpace(r.URL.Query().Get("folderId")); value != "" {
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed <= 0 {
			writeAPIError(w, http.StatusBadRequest, "invalid_folder_id", "Invalid record folder.", false)
			return
		}
		parent = parsed
	}
	folders, assets, err := s.recordStore.ListTree(r.Context(), parent, 200)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_tree_failed", "The record directory could not be read.", true)
		return
	}
	for i := range assets {
		if assets[i].Kind == "video" || assets[i].Kind == "image" {
			assets[i].StreamURL = "/api/records/assets/" + strconv.FormatInt(assets[i].ID, 10) + "/stream"
		}
	}
	for i := range folders {
		id := strconv.FormatInt(folders[i].ID, 10)
		if path, asset, artworkErr := s.recordStore.ArtworkPath(r.Context(), folders[i].ID, "poster"); artworkErr == nil && record.ValidateImageFile(path, asset.MimeType) == nil {
			folders[i].Artwork.PosterURL = "/api/records/folders/" + id + "/artwork/poster"
		}
		if path, asset, artworkErr := s.recordStore.ArtworkPath(r.Context(), folders[i].ID, "backdrop"); artworkErr == nil && record.ValidateImageFile(path, asset.MimeType) == nil {
			folders[i].Artwork.BackdropURL = "/api/records/folders/" + id + "/artwork/backdrop"
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"folderId": parent, "folders": folders, "assets": assets})
}

func (s *Server) initializeRecordRoot(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	root, err := s.recordStore.InitializeRoot(r.Context())
	if err != nil {
		writeAPIError(w, http.StatusConflict, "record_root_initialization_failed", "The record library could not be initialized.", false)
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
	if a.Kind == "video" || a.Kind == "image" {
		a.StreamURL = "/api/records/assets/" + strconv.FormatInt(a.ID, 10) + "/stream"
	}
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
	if err != nil || (asset.Kind != "video" && asset.Kind != "image") || asset.Availability != "available" {
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
	if root.State != "online" {
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
	if asset.Kind != "video" {
		writeAPIError(w, http.StatusBadRequest, "record_progress_not_supported", "Progress is supported for videos only.", false)
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
	user, ok := s.requirePermission(w, r, "library:write")
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
	if asset.Kind != "video" {
		writeAPIError(w, http.StatusBadRequest, "record_progress_not_supported", "Progress is supported for videos only.", false)
		return
	}
	var input struct {
		PositionSeconds float64  `json:"positionSeconds"`
		DurationSeconds *float64 `json:"durationSeconds"`
		Completed       bool     `json:"completed"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&input); err != nil || input.PositionSeconds < 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_record_progress", "Invalid record progress.", false)
		return
	}
	if err := s.recordStore.SaveProgress(r.Context(), user.ID, id, record.Progress{PositionSeconds: input.PositionSeconds, DurationSeconds: input.DurationSeconds, Completed: input.Completed}); err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_progress_failed", "The record progress could not be saved.", true)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
