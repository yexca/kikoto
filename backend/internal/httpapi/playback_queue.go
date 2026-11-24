package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
)

// maxPlaybackQueueResolveItems bounds one queue resolve request; the player
// sends a longer queue in parts of this size.
const maxPlaybackQueueResolveItems = 1000

// maxPlaybackQueueResolveWorks bounds the distinct works one queue resolve
// request names. Each work loads its files and details one after another, so
// the bound keeps a request, which anonymous visitors may also send, from
// costing more than a page of works; the player starts a new part at it.
const maxPlaybackQueueResolveWorks = 100

const (
	// playbackQueueItemPlayable is a queued item with a location to play from.
	playbackQueueItemPlayable = "playable"
	// playbackQueueItemUnavailable is a queued item that still exists but has
	// no location that can play now, such as one on an offline storage pool.
	playbackQueueItemUnavailable = "unavailable"
	// playbackQueueItemMissing is a queued item, or the work it was queued
	// from, that no longer exists or that this viewer may not open.
	playbackQueueItemMissing = "missing"
)

// playbackQueueTrack is everything the player needs to queue a work file.
type playbackQueueTrack struct {
	MediaItemID int64 `json:"mediaItemId"`
	// WorkID is the work the track is queued from.
	WorkID     int64 `json:"workId"`
	LocationID int64 `json:"locationId"`
	// Title is the file's real name, which also names it for lyrics matching;
	// DisplayTitle is the name the viewer's metadata languages give it.
	Title        string `json:"title"`
	DisplayTitle string `json:"displayTitle,omitempty"`
	Kind         string `json:"kind"`
	// FolderPath is the file's folder in the work's Directory tree.
	FolderPath      string               `json:"folderPath"`
	LocationType    string               `json:"locationType"`
	StreamURL       string               `json:"streamUrl"`
	Availability    string               `json:"availability"`
	SizeBytes       *int64               `json:"sizeBytes"`
	DurationSeconds *int64               `json:"durationSeconds"`
	Progress        *mediaProgressDetail `json:"progress"`
	// Locations are the locations the track can play from, in playback
	// priority.
	Locations []playbackLocation `json:"locations"`
	// LyricsChoices ranks the lyrics the track can show; the first is the
	// automatic choice and PreferredLyricsMediaItemID the viewer's own.
	LyricsChoices               []playbackLyricsChoice `json:"lyricsChoices"`
	PreferredLyricsMediaItemID  *int64                 `json:"preferredLyricsMediaItemId"`
	LyricsOffsetMs              int64                  `json:"lyricsOffsetMs"`
	LyricsPreferencePersistable bool                   `json:"lyricsPreferencePersistable"`
}

// playbackLyricsChoice is a lyrics file a track can show, as the player
// reads it.
type playbackLyricsChoice struct {
	MediaItemID int64  `json:"mediaItemId"`
	LocationID  int64  `json:"locationId"`
	Title       string `json:"title"`
	Path        string `json:"path"`
	// DisplayPath is the file's path in the work's Directory tree.
	DisplayPath string          `json:"displayPath,omitempty"`
	Reason      string          `json:"reason"`
	Language    string          `json:"language,omitempty"`
	AI          *lyricsAIModels `json:"ai,omitempty"`
}

// playbackQueueWork is the work information the player shows with a track.
type playbackQueueWork struct {
	ID          int64    `json:"id"`
	PrimaryCode string   `json:"primaryCode"`
	Title       string   `json:"title"`
	CoverURL    string   `json:"coverUrl"`
	Circle      string   `json:"circle"`
	VoiceActors []string `json:"voiceActors"`
}

type playbackQueueResolveItem struct {
	MediaItemID int64 `json:"mediaItemId"`
	WorkID      int64 `json:"workId"`
	// LocationID is the location the track was on; LocationChosen says the
	// listener picked it in the player.
	LocationID     int64 `json:"locationId"`
	LocationChosen bool  `json:"locationChosen"`
}

type playbackQueueResolvedItem struct {
	MediaItemID int64               `json:"mediaItemId"`
	WorkID      int64               `json:"workId"`
	Status      string              `json:"status"`
	Track       *playbackQueueTrack `json:"track,omitempty"`
}

type playbackQueueResolveResponse struct {
	Items []playbackQueueResolvedItem `json:"items"`
	Works []playbackQueueWork         `json:"works"`
}

// workResumeQueue is the queue Resume plays: the playable files of the
// cursor's edition in the work playback order, starting at the cursor's
// track and position.
type workResumeQueue struct {
	MediaWorkID     int64                `json:"mediaWorkId"`
	StartIndex      int                  `json:"startIndex"`
	PositionSeconds float64              `json:"positionSeconds"`
	Tracks          []playbackQueueTrack `json:"tracks"`
	Work            playbackQueueWork    `json:"work"`
}

// queuedWorkMedia is a work's media as the player queues it.
type queuedWorkMedia struct {
	workID int64
	code   string
	items  []mediaItemDetail
	byID   map[int64]*mediaItemDetail
	tree   workPlaybackTree
	local  map[int64]localLyricsFile
}

type localLyricsFile struct {
	item     *mediaItemDetail
	location fileLocationDetail
}

func newQueuedWorkMedia(workID int64, code string, items []mediaItemDetail) *queuedWorkMedia {
	media := &queuedWorkMedia{workID: workID, code: code, items: items, byID: map[int64]*mediaItemDetail{}, local: map[int64]localLyricsFile{}}
	for index := range media.items {
		item := &media.items[index]
		media.byID[item.ID] = item
		for _, location := range item.Locations {
			if location.LocationType == "local" {
				media.local[location.ID] = localLyricsFile{item: item, location: location}
			}
		}
	}
	media.tree = buildWorkPlaybackTree(media.items)
	return media
}

// track is a tree file queued on one of its playback locations.
func (media *queuedWorkMedia) track(file *playbackTreeFile, location playbackLocation) playbackQueueTrack {
	item := file.item
	kind := "audio"
	if item.Kind == "video" {
		kind = "video"
	}
	durationSeconds := file.location.DurationSeconds
	if durationSeconds == nil {
		durationSeconds = item.DurationSeconds
	}
	return playbackQueueTrack{
		MediaItemID:                 item.ID,
		WorkID:                      media.workID,
		LocationID:                  location.LocationID,
		Title:                       file.title,
		DisplayTitle:                file.displayTitle,
		Kind:                        kind,
		FolderPath:                  file.folderPath,
		LocationType:                location.LocationType,
		StreamURL:                   location.StreamURL,
		Availability:                location.Availability,
		SizeBytes:                   file.location.SizeBytes,
		DurationSeconds:             durationSeconds,
		Progress:                    item.Progress,
		Locations:                   item.PlaybackLocations,
		LyricsChoices:               media.lyricsChoices(file),
		PreferredLyricsMediaItemID:  item.PreferredLyricsMediaItemID,
		LyricsOffsetMs:              item.LyricsOffsetMs,
		LyricsPreferencePersistable: item.Kind == "audio",
	}
}

// lyricsChoices resolves the server's lyrics choices for a file's tree
// location into the local lyrics files the player reads.
func (media *queuedWorkMedia) lyricsChoices(file *playbackTreeFile) []playbackLyricsChoice {
	choices := []playbackLyricsChoice{}
	if file.item.Kind != "audio" && file.item.Kind != "video" {
		return choices
	}
	for _, choice := range file.location.LyricsChoices {
		lyrics, ok := media.local[choice.LocationID]
		if !ok {
			continue
		}
		resolved := playbackLyricsChoice{
			MediaItemID: choice.LyricsMediaItemID,
			LocationID:  choice.LocationID,
			Title:       lastPathSegment(lyrics.location.Path),
			Path:        lyrics.location.Path,
			Reason:      choice.Reason,
			Language:    choice.Language,
		}
		if shown, ok := media.tree.byLocation[choice.LocationID]; ok {
			resolved.DisplayPath = shown.sourcePath
		}
		if choice.Reason == lyricsReasonAssigned {
			resolved.AI = lyrics.item.AILyrics
		}
		choices = append(choices, resolved)
	}
	return choices
}

func lastPathSegment(path string) string {
	parts := splitPathSegments(strings.ReplaceAll(path, "\\", "/"))
	if len(parts) == 0 {
		return path
	}
	return parts[len(parts)-1]
}

// mediaItemDisplayTitle is the display name the viewer's metadata languages
// give a media item's file, read from the given location or, failing that,
// any location that has one; empty when the file shows its real name.
func mediaItemDisplayTitle(item mediaItemDetail, locationID int64) string {
	var named *fileLocationDetail
	for index := range item.Locations {
		location := &item.Locations[index]
		if location.DisplayPath == "" {
			continue
		}
		if location.ID == locationID {
			named = location
			break
		}
		if named == nil {
			named = location
		}
	}
	if named == nil {
		return ""
	}
	shown := lastPathSegment(named.DisplayPath)
	if shown == lastPathSegment(named.Path) {
		return ""
	}
	return shown
}

func playbackQueueWorkFrom(work workDetail) playbackQueueWork {
	voiceActors := work.VoiceActors
	if voiceActors == nil {
		voiceActors = []string{}
	}
	return playbackQueueWork{
		ID:          work.ID,
		PrimaryCode: work.PrimaryCode,
		Title:       work.Title,
		CoverURL:    work.CoverURL,
		Circle:      work.Circle,
		VoiceActors: voiceActors,
	}
}

// playbackQueueResolveRequest is a read despite its POST transport: it names
// the queued items in its body and stores nothing, so Demo and anonymous
// visitors resolve their queues like any other read.
func playbackQueueResolveRequest(r *http.Request) bool {
	return r.Method == http.MethodPost && r.URL.Path == "/api/playback/queue/resolve"
}

// resolvePlaybackQueue refreshes a restored player queue against the library
// in one request: every item comes back playable with its current locations,
// names, lyrics, and work information, or as unavailable or missing. Only
// names are resolved when titlesOnly is set.
func (s *Server) resolvePlaybackQueue(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Items      []playbackQueueResolveItem `json:"items"`
		TitlesOnly bool                       `json:"titlesOnly"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", false)
		return
	}
	if len(payload.Items) > maxPlaybackQueueResolveItems {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "too many queue items", false)
		return
	}
	works := map[int64]bool{}
	for _, item := range payload.Items {
		if item.WorkID > 0 {
			works[item.WorkID] = true
		}
	}
	if len(works) > maxPlaybackQueueResolveWorks {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "too many queue works", false)
		return
	}
	response, err := s.resolvePlaybackQueueItems(r.Context(), optionalUserID(r.Context()), payload.Items, payload.TitlesOnly)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) resolvePlaybackQueueItems(ctx context.Context, userID int64, items []playbackQueueResolveItem, titlesOnly bool) (playbackQueueResolveResponse, error) {
	response := playbackQueueResolveResponse{Items: make([]playbackQueueResolvedItem, 0, len(items)), Works: []playbackQueueWork{}}
	media := map[int64]*queuedWorkMedia{}
	for _, requested := range items {
		if requested.WorkID <= 0 {
			continue
		}
		if _, loaded := media[requested.WorkID]; loaded {
			continue
		}
		if err := ctx.Err(); err != nil {
			return playbackQueueResolveResponse{}, err
		}
		workMedia, work, err := s.loadQueuedWorkMedia(ctx, userID, requested.WorkID, !titlesOnly)
		if err != nil {
			return playbackQueueResolveResponse{}, err
		}
		media[requested.WorkID] = workMedia
		if work != nil {
			response.Works = append(response.Works, *work)
		}
	}
	for _, requested := range items {
		resolved := playbackQueueResolvedItem{MediaItemID: requested.MediaItemID, WorkID: requested.WorkID, Status: playbackQueueItemMissing}
		workMedia := media[requested.WorkID]
		var item *mediaItemDetail
		if workMedia != nil {
			item = workMedia.byID[requested.MediaItemID]
		}
		if item != nil {
			resolved.Status = playbackQueueItemUnavailable
			file := workMedia.tree.byItem[item.ID]
			if location := keptPlaybackLocation(item.PlaybackLocations, requested.LocationID, requested.LocationChosen); location != nil && file != nil {
				track := workMedia.track(file, *location)
				track.DisplayTitle = mediaItemDisplayTitle(*item, requested.LocationID)
				resolved.Status = playbackQueueItemPlayable
				resolved.Track = &track
			}
		}
		response.Items = append(response.Items, resolved)
	}
	return response, nil
}

// loadQueuedWorkMedia loads the media a work's queued tracks come from, the
// same media its work page plays, and its work information when asked. It
// returns nil media for a work that does not exist or that this viewer may
// not open.
func (s *Server) loadQueuedWorkMedia(ctx context.Context, userID int64, workID int64, withWork bool) (*queuedWorkMedia, *playbackQueueWork, error) {
	eligible, err := s.demoWorkEligible(ctx, workID)
	if errors.Is(err, sql.ErrNoRows) || err == nil && !eligible {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if localOnlyRequest(ctx) {
		local, err := s.workFamilyHasLocalFolder(ctx, workID)
		if err != nil || !local {
			return nil, nil, err
		}
	}
	var code string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	mediaWorkID, err := s.resolveMediaWorkIDForRequest(ctx, workID)
	if err != nil {
		return nil, nil, err
	}
	items, err := s.loadWorkMediaItems(ctx, userID, mediaWorkID)
	if err != nil {
		return nil, nil, err
	}
	if localOnlyRequest(ctx) {
		localMediaLocations(items)
	}
	var work *playbackQueueWork
	if withWork {
		detail, err := s.loadWorkDetail(ctx, userID, workID, false)
		if err != nil {
			return nil, nil, err
		}
		presented := playbackQueueWorkFrom(detail)
		work = &presented
	}
	return newQueuedWorkMedia(workID, code, items), work, nil
}

// getWorkResumeQueue answers the queue Resume plays for a work's saved
// playback cursor; resume is null when the cursor cannot resume.
func (s *Server) getWorkResumeQueue(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid work id", false)
		return
	}
	if !s.requireDemoWork(w, r, workID) {
		return
	}
	cursor, err := s.loadWorkPlaybackCursor(r.Context(), user.ID, workID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "work not found", false)
			return
		}
		writeError(w, err)
		return
	}
	resume, err := s.buildWorkResumeQueue(r.Context(), user.ID, cursor)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"resume": resume})
}

func (s *Server) buildWorkResumeQueue(ctx context.Context, userID int64, cursor *workProgressSummary) (*workResumeQueue, error) {
	if cursor == nil || cursor.MediaItemID == nil || cursor.MediaWorkID == nil || cursor.Completed ||
		math.IsNaN(cursor.PositionSeconds) || math.IsInf(cursor.PositionSeconds, 0) || cursor.PositionSeconds <= 0 {
		return nil, nil
	}
	mediaWorkID := *cursor.MediaWorkID
	if eligible, err := s.demoWorkEligible(ctx, mediaWorkID); errors.Is(err, sql.ErrNoRows) || err == nil && !eligible {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	detail, err := s.loadWorkDetail(ctx, userID, mediaWorkID, false)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	items, err := s.loadWorkMediaItems(ctx, userID, mediaWorkID)
	if err != nil {
		return nil, err
	}
	if localOnlyRequest(ctx) {
		localMediaLocations(items)
	}
	media := newQueuedWorkMedia(mediaWorkID, detail.PrimaryCode, items)
	files := media.tree.playableFiles()
	resume := &workResumeQueue{
		MediaWorkID:     mediaWorkID,
		StartIndex:      -1,
		PositionSeconds: cursor.PositionSeconds,
		Tracks:          make([]playbackQueueTrack, 0, len(files)),
		Work:            playbackQueueWorkFrom(detail),
	}
	for index, file := range files {
		location := playbackLocation{
			LocationID:   file.location.ID,
			LocationType: file.location.LocationType,
			StreamURL:    file.streamURL,
			SourceID:     file.location.FileSourceID,
			SourceName:   file.location.FileSourceName,
			Availability: file.location.Availability,
		}
		if len(file.item.PlaybackLocations) > 0 {
			location = file.item.PlaybackLocations[0]
		}
		if file.item.ID == *cursor.MediaItemID && resume.StartIndex < 0 {
			cursorLocation := resumeCursorLocation(file.item.PlaybackLocations, cursor)
			if cursorLocation == nil {
				return nil, nil
			}
			location = *cursorLocation
			resume.StartIndex = index
		}
		resume.Tracks = append(resume.Tracks, media.track(file, location))
	}
	if resume.StartIndex < 0 {
		return nil, nil
	}
	return resume, nil
}

// resumeCursorLocation is where Resume continues the cursor's track: the
// cursor's own location, else one of the same source and type, else one of
// the same source, else the first choice.
func resumeCursorLocation(locations []playbackLocation, cursor *workProgressSummary) *playbackLocation {
	matchers := []func(playbackLocation) bool{
		func(location playbackLocation) bool {
			return cursor.LocationID != nil && location.LocationID == *cursor.LocationID
		},
		func(location playbackLocation) bool {
			return cursor.FileSourceID != nil && location.SourceID == *cursor.FileSourceID && location.LocationType == cursor.LocationType
		},
		func(location playbackLocation) bool {
			return cursor.FileSourceID != nil && location.SourceID == *cursor.FileSourceID
		},
	}
	for _, matches := range matchers {
		for index := range locations {
			if matches(locations[index]) {
				return &locations[index]
			}
		}
	}
	if len(locations) == 0 {
		return nil
	}
	return &locations[0]
}
