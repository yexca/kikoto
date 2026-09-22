package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type remoteWorkDetail struct {
	SourceID         int64                    `json:"sourceId"`
	SourceCode       string                   `json:"sourceCode"`
	SourceName       string                   `json:"sourceName"`
	RemoteID         string                   `json:"remoteId"`
	PrimaryCode      string                   `json:"primaryCode"`
	RemoteCode       string                   `json:"remoteCode"`
	Title            string                   `json:"title"`
	CoverURL         string                   `json:"coverUrl"`
	SourceURL        string                   `json:"sourceUrl"`
	PublicWorkURL    string                   `json:"publicWorkUrl"`
	Circle           string                   `json:"circle"`
	CircleRef        *remoteEntityRef         `json:"circleRef,omitempty"`
	Rating           *float64                 `json:"rating"`
	RatingCount      *int64                   `json:"ratingCount"`
	Sales            *int64                   `json:"sales"`
	Price            *int64                   `json:"price"`
	AgeRating        string                   `json:"ageRating"`
	ReleaseDate      string                   `json:"releaseDate"`
	DurationSeconds  *int64                   `json:"durationSeconds"`
	Tags             []string                 `json:"tags"`
	VoiceActors      []string                 `json:"voiceActors"`
	VoiceRefs        []remoteEntityRef        `json:"voiceRefs"`
	ImportStatus     string                   `json:"importStatus"`
	WorkID           *int64                   `json:"workId"`
	MetadataView     workMetadataPresentation `json:"metadataPresentation"`
	Tracks           []remoteTrackDetail      `json:"tracks,omitempty"`
	LanguageEditions []remoteLanguageEdition  `json:"languageEditions"`
}

type remoteWorkTracksDetail struct {
	SourceID    int64               `json:"sourceId"`
	SourceCode  string              `json:"sourceCode"`
	SourceName  string              `json:"sourceName"`
	RemoteID    string              `json:"remoteId"`
	PrimaryCode string              `json:"primaryCode"`
	RemoteCode  string              `json:"remoteCode"`
	Tracks      []remoteTrackDetail `json:"tracks"`
}

type remoteLanguageEdition struct {
	RemoteCode   string `json:"remoteCode"`
	Language     string `json:"language"`
	Label        string `json:"label"`
	DisplayOrder int    `json:"displayOrder"`
	Current      bool   `json:"current"`
	Origin       bool   `json:"origin"`
}

type remoteEntityRef struct {
	SourceID   int64  `json:"sourceId"`
	ExternalID string `json:"externalId"`
	Name       string `json:"name"`
}

type remoteTrackDetail struct {
	Type            string              `json:"type"`
	Title           string              `json:"title"`
	Hash            string              `json:"hash"`
	StreamURL       string              `json:"streamUrl"`
	DownloadURL     string              `json:"downloadUrl"`
	DurationSeconds *int64              `json:"durationSeconds"`
	SizeBytes       *int64              `json:"sizeBytes"`
	CacheLocationID *int64              `json:"cacheLocationId"`
	CachePath       string              `json:"cachePath"`
	CacheAvailable  bool                `json:"cacheAvailable"`
	LocalLocationID *int64              `json:"localLocationId"`
	LocalPath       string              `json:"localPath"`
	LocalAvailable  bool                `json:"localAvailable"`
	Children        []remoteTrackDetail `json:"children"`
}

func (s *Server) getRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	source, remoteWork, err := s.loadRemoteWorkCached(r.Context(), id, code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeUpstreamError(w, err)
		return
	}
	languages := remoteSourceRequestLanguages(source.Config.RequestLanguage)
	detail, err := s.remoteWorkDetailWithLanguages(r.Context(), source, remoteWork, languages)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) getRemoteSourceWorkTracks(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	source, remoteWork, tracks, err := s.loadRemoteWorkTracksCached(r.Context(), id, code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeUpstreamError(w, err)
		return
	}
	detail, err := s.remoteWorkTracksDetail(r.Context(), source, remoteWork, tracks)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) remoteWorkDetailWithLanguages(ctx context.Context, source remoteSourceForUse, work kikoeru.Work, languages []string) (remoteWorkDetail, error) {
	projected := newRemoteCatalogProjectorWithLanguages(languages).project(source.ID, work)
	code := projected.RemoteCode
	displayCode := code
	ref, err := s.canonicalWorkForCode(ctx, code)
	if err != nil {
		return remoteWorkDetail{}, err
	}
	var workID *int64
	if ref.Code != "" {
		displayCode = ref.Code
	}
	if ref.Known && ref.WorkID > 0 {
		workID = &ref.WorkID
	}
	status := "remote_only"
	if workID != nil {
		status = "synced"
	}
	releaseDate := ""
	if value, ok := normalizeDate(projected.ReleaseDate).(string); ok {
		releaseDate = value
	}
	return remoteWorkDetail{
		SourceID:         source.ID,
		SourceCode:       source.Code,
		SourceName:       source.DisplayName,
		RemoteID:         projected.RemoteID,
		PrimaryCode:      displayCode,
		RemoteCode:       code,
		Title:            firstNonEmpty(projected.Title, displayCode),
		CoverURL:         projected.CoverURL,
		SourceURL:        projected.SourceURL,
		PublicWorkURL:    publicRemoteWorkURL(source.Endpoint, code),
		Circle:           projected.Circle,
		CircleRef:        projected.CircleRef,
		Rating:           projected.Rating,
		RatingCount:      projected.RatingCount,
		Sales:            projected.Sales,
		Price:            projected.Price,
		AgeRating:        projected.AgeRating,
		ReleaseDate:      releaseDate,
		DurationSeconds:  projected.DurationSeconds,
		Tags:             projected.Tags,
		VoiceActors:      projected.VoiceActors,
		VoiceRefs:        projected.VoiceRefs,
		ImportStatus:     status,
		WorkID:           workID,
		MetadataView:     remoteWorkMetadataPresentation(work, languages),
		LanguageEditions: normalizedRemoteLanguageEditions(work),
	}, nil
}

func (s *Server) remoteWorkTracksDetail(ctx context.Context, source remoteSourceForUse, work kikoeru.Work, tracks []kikoeru.Track) (remoteWorkTracksDetail, error) {
	code := normalizedRemoteWorkCode(work)
	if code == "" {
		code = strings.TrimSpace(work.SourceID)
	}
	locationState, err := s.remoteTrackLocationState(ctx, source.ID, code)
	if err != nil {
		return remoteWorkTracksDetail{}, err
	}
	return remoteWorkTracksDetail{
		SourceID:    source.ID,
		SourceCode:  source.Code,
		SourceName:  source.DisplayName,
		RemoteID:    strconv.FormatInt(work.ID, 10),
		PrimaryCode: code,
		RemoteCode:  code,
		Tracks:      remoteTrackDetails(source.Code, code, tracks, "", locationState),
	}, nil
}

func normalizedRemoteLanguageEditions(work kikoeru.Work) []remoteLanguageEdition {
	currentCode := normalizedRemoteWorkCode(work)
	originOrder := earliestRemoteLanguageEditionOrder(work.LanguageEditions)
	declared := make(map[string]kikoeru.LanguageEdition, len(work.LanguageEditions))
	for _, edition := range work.LanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if workflowGraphWorkCodePattern.MatchString(code) {
			declared[code] = edition
		}
	}
	result := make([]remoteLanguageEdition, 0, len(work.OtherLanguageEditions)+1)
	seen := map[string]bool{}
	if currentCode != "" {
		edition, ok := declared[currentCode]
		item := newRemoteLanguageEdition(edition, currentCode, currentCode, originOrder, !ok)
		item.Label = firstNonEmpty(strings.TrimSpace(work.Title), item.Label, currentCode)
		if originalCode := strings.ToUpper(strings.TrimSpace(work.OriginalWorkNumber)); originalCode != "" {
			item.Origin = strings.EqualFold(originalCode, currentCode)
		}
		result = append(result, item)
		seen[currentCode] = true
	}
	for _, available := range work.OtherLanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(available.SourceID))
		if !workflowGraphWorkCodePattern.MatchString(code) || seen[code] {
			continue
		}
		seen[code] = true
		item := newRemoteLanguageEdition(declared[code], code, currentCode, originOrder, false)
		item.Language = firstNonEmpty(strings.TrimSpace(available.Language), item.Language)
		item.Label = firstNonEmpty(strings.TrimSpace(available.Title), item.Label, item.Language, code)
		item.Origin = available.IsOriginal || item.Origin
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool { return remoteLanguageEditionLess(result[i], result[j]) })
	return result
}

func earliestRemoteLanguageEditionOrder(editions kikoeru.LanguageEditionList) int {
	order := 0
	for _, edition := range editions {
		if edition.DisplayOrder > 0 && (order == 0 || edition.DisplayOrder < order) {
			order = edition.DisplayOrder
		}
	}
	return order
}

func newRemoteLanguageEdition(edition kikoeru.LanguageEdition, code, currentCode string, originOrder int, first bool) remoteLanguageEdition {
	origin := edition.DisplayOrder > 0 && edition.DisplayOrder == originOrder
	if originOrder == 0 && first {
		origin = true
	}
	language := strings.TrimSpace(edition.Language)
	return remoteLanguageEdition{
		RemoteCode: code, Language: language, Label: firstNonEmpty(strings.TrimSpace(edition.Label), language, code),
		DisplayOrder: edition.DisplayOrder, Current: strings.EqualFold(code, currentCode), Origin: origin,
	}
}

func remoteLanguageEditionLess(left, right remoteLanguageEdition) bool {
	if left.Origin != right.Origin {
		return left.Origin
	}
	leftOrder, rightOrder := remoteLanguageEditionOrder(left), remoteLanguageEditionOrder(right)
	if leftOrder != rightOrder {
		return leftOrder < rightOrder
	}
	return left.RemoteCode < right.RemoteCode
}

func remoteLanguageEditionOrder(edition remoteLanguageEdition) int {
	if edition.DisplayOrder <= 0 {
		return int(^uint(0) >> 1)
	}
	return edition.DisplayOrder
}

type remoteTrackLocationState struct {
	ID          int64
	MediaItemID int64
	Path        string
	SizeBytes   *int64
	Available   bool
}

type remoteTrackLocationStates struct {
	Cache map[string]remoteTrackLocationState
	Local map[string]remoteTrackLocationState
}

func (s *Server) remoteTrackLocationState(ctx context.Context, remoteSourceID int64, workCode string) (remoteTrackLocationStates, error) {
	states := remoteTrackLocationStates{
		Cache: map[string]remoteTrackLocationState{},
		Local: map[string]remoteTrackLocationState{},
	}
	if workCode == "" {
		return states, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.media_item_id, location.location_type, location.path, location.size_bytes, location.availability
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		WHERE work.primary_code = ?
			AND location.location_type IN ('cache', 'local')
			AND (
				location.file_source_id = ?
				OR location.location_type = 'local'
			)
	`, workCode, remoteSourceID)
	if err != nil {
		return states, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var mediaItemID int64
		var locationType string
		var path string
		var size sql.NullInt64
		var availability string
		if err := rows.Scan(&id, &mediaItemID, &locationType, &path, &size, &availability); err != nil {
			return states, err
		}
		state := remoteTrackLocationState{ID: id, MediaItemID: mediaItemID, Path: filepath.ToSlash(path), Available: availability == "available"}
		if size.Valid {
			value := size.Int64
			state.SizeBytes = &value
		}
		switch locationType {
		case "cache":
			states.Cache[state.Path] = state
		case "local":
			states.Local[state.Path] = state
		}
	}
	return states, rows.Err()
}

func remoteTrackDetails(sourceCode string, workCode string, tracks []kikoeru.Track, basePath string, locationState remoteTrackLocationStates) []remoteTrackDetail {
	result := make([]remoteTrackDetail, 0, len(tracks))
	for index, track := range tracks {
		title := strings.TrimSpace(track.Title)
		if title == "" {
			title = fmt.Sprintf("Track %d", index+1)
		}
		path := cleanRemoteRelativePath(joinRemotePath(basePath, title))
		var duration *int64
		if track.Duration > 0 {
			value := int64(track.Duration)
			duration = &value
		}
		var size *int64
		if track.Size > 0 {
			value := track.Size
			size = &value
		}
		detail := remoteTrackDetail{
			Type:            remoteTrackKindForPath(track.Type, path),
			Title:           title,
			Hash:            track.Hash,
			StreamURL:       firstNonEmpty(track.MediaStreamURL, track.StreamLowQualityURL),
			DownloadURL:     track.MediaDownloadURL,
			DurationSeconds: duration,
			SizeBytes:       size,
			Children:        []remoteTrackDetail{},
		}
		if len(track.Children) > 0 || detail.Type == "folder" {
			detail.Children = remoteTrackDetails(sourceCode, workCode, track.Children, path, locationState)
		} else {
			cachePath := cacheMediaRelPath(sourceCode, workCode, path)
			if state, ok := locationState.Cache[cachePath]; ok {
				detail.CacheLocationID = &state.ID
				detail.CachePath = state.Path
				detail.CacheAvailable = state.Available
			}
			if state, ok := locationState.localForRemotePath(path); ok {
				detail.LocalLocationID = &state.ID
				detail.LocalPath = state.Path
				detail.LocalAvailable = state.Available
			}
		}
		result = append(result, detail)
	}
	return result
}

func (states remoteTrackLocationStates) localForRemotePath(remotePath string) (remoteTrackLocationState, bool) {
	if state, ok := states.Local[remotePath]; ok {
		return state, true
	}
	for localPath, state := range states.Local {
		if strings.HasSuffix(localPath, "/"+remotePath) {
			return state, true
		}
	}
	return remoteTrackLocationState{}, false
}

func trimLocalPathToWorkRoot(path string, files []remoteWorkSaveLocalFile) string {
	root := commonLocalDirectoryPrefix(files)
	normalized := filepath.ToSlash(path)
	if root == "" {
		return filepath.Base(normalized)
	}
	if normalized == root {
		return filepath.Base(normalized)
	}
	if strings.HasPrefix(normalized, root+"/") {
		return strings.TrimPrefix(normalized, root+"/")
	}
	return normalized
}

func commonLocalDirectoryPrefix(files []remoteWorkSaveLocalFile) string {
	if len(files) == 0 {
		return ""
	}
	parts := localDirectoryParts(files[0].Path)
	prefix := []string{}
	for index, part := range parts {
		if part == "" {
			continue
		}
		for _, file := range files[1:] {
			other := localDirectoryParts(file.Path)
			if index >= len(other) || other[index] != part {
				if len(prefix) <= 1 {
					return ""
				}
				return strings.Join(prefix, "/")
			}
		}
		prefix = append(prefix, part)
	}
	if len(prefix) <= 1 {
		return ""
	}
	return strings.Join(prefix, "/")
}

func localDirectoryParts(path string) []string {
	dir := filepath.ToSlash(filepath.Dir(filepath.ToSlash(path)))
	if dir == "." || dir == "/" {
		return nil
	}
	return strings.Split(strings.Trim(dir, "/"), "/")
}

func mediaKindFromPath(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp3", ".wav", ".flac", ".m4a", ".wma", ".ogg", ".oga", ".opus", ".aac":
		return "audio"
	case ".mp4", ".m4v", ".webm", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".f4v", ".mpeg", ".mpg", ".mpe", ".m2v", ".m2ts", ".mts", ".ts", ".3gp", ".3g2", ".ogv", ".asf", ".rm", ".rmvb", ".vob", ".divx", ".xvid", ".mxf", ".ogm", ".svi", ".nsv", ".wtv", ".amv", ".mjpeg", ".mjpg", ".dv", ".y4m", ".ismv", ".ism":
		return "video"
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp":
		return "image"
	case ".txt", ".lrc", ".srt", ".vtt", ".ass":
		return "text"
	default:
		return "file"
	}
}
