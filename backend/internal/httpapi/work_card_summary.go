package httpapi

import (
	"context"
	"database/sql"
	"strings"
)

// workLyricsFile is one file location that takes part in a work's lyrics
// status: a track, or a file that can serve as its lyrics.
type workLyricsFile struct {
	itemID int64
	kind   string
	local  bool
	// sourceID is the file source of a location that is not local.
	sourceID int64
	path     string
	// assignedLyricsItemID is the library lyrics assignment of an audio item,
	// or zero.
	assignedLyricsItemID int64
}

func (file workLyricsFile) isTrack() bool {
	return file.kind == "audio" || file.kind == "video"
}

// matchScope groups the files that name matching compares: every local file
// of the work, or the files of one remote source.
func (file workLyricsFile) matchScope() int64 {
	if file.local {
		return 0
	}
	return file.sourceID
}

// loadWorksWithLyrics reports the works whose tracks have lyrics the way
// playback resolves them: a library lyrics assignment whose file is
// available, or a lyrics file that name matching picks for a track. A work
// without tracks of its own takes the status of the other editions of its
// logical work, whose media its detail shows.
func (s *Server) loadWorksWithLyrics(ctx context.Context, workIDs []int64) (map[int64]bool, error) {
	result := map[int64]bool{}
	workIDs = uniquePositiveInt64s(workIDs)
	if len(workIDs) == 0 {
		return result, nil
	}
	siblings := map[int64][]int64{}
	if err := s.queryInt64Batches(ctx, `
		SELECT current.work_id, sibling.work_id
		FROM work_edition AS current
		INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current.logical_work_id
		WHERE current.work_id IN (%s)
			AND sibling.work_id <> current.work_id
	`, workIDs, nil, func(rows *sql.Rows) error {
		var workID, siblingID int64
		if err := rows.Scan(&workID, &siblingID); err != nil {
			return err
		}
		siblings[workID] = append(siblings[workID], siblingID)
		return nil
	}); err != nil {
		return nil, err
	}
	familyIDs := append([]int64{}, workIDs...)
	// A work with other editions needs its own tracks loaded even when it has
	// no lyrics file, to tell whether it has tracks at all.
	trackWorkIDs := []int64{}
	for _, workID := range workIDs {
		if len(siblings[workID]) > 0 {
			familyIDs = append(familyIDs, siblings[workID]...)
			trackWorkIDs = append(trackWorkIDs, workID)
		}
	}
	familyIDs = uniquePositiveInt64s(familyIDs)

	// Tracks are loaded only for works that have a file to match them against,
	// so a library-wide list does not read every track of every work.
	files := map[int64][]workLyricsFile{}
	if err := s.loadWorkLyricsFiles(ctx, familyIDs, "'text', 'file'", files); err != nil {
		return nil, err
	}
	for workID := range files {
		trackWorkIDs = append(trackWorkIDs, workID)
	}
	if err := s.loadWorkLyricsFiles(ctx, uniquePositiveInt64s(trackWorkIDs), "'audio', 'video'", files); err != nil {
		return nil, err
	}

	hasTracks := map[int64]bool{}
	hasLyrics := map[int64]bool{}
	for workID, workFiles := range files {
		hasTracks[workID], hasLyrics[workID] = workLyricsStatus(workFiles)
	}
	for _, workID := range workIDs {
		if hasTracks[workID] {
			result[workID] = hasLyrics[workID]
			continue
		}
		for _, siblingID := range siblings[workID] {
			if hasLyrics[siblingID] {
				result[workID] = true
				break
			}
		}
	}
	return result, nil
}

// loadWorkLyricsFiles appends the usable locations of the works' media items
// of the given kinds: available through an enabled source, and not a cache
// copy of a file that is already listed at its source.
func (s *Server) loadWorkLyricsFiles(ctx context.Context, workIDs []int64, kinds string, files map[int64][]workLyricsFile) error {
	return s.queryInt64Batches(ctx, `
		SELECT item.work_id, item.id, item.kind, location.location_type, location.file_source_id, location.path,
			COALESCE(assignment.lyrics_media_item_id, 0)
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		LEFT JOIN media_lyrics_assignment AS assignment ON assignment.audio_media_item_id = item.id
		WHERE item.work_id IN (%s)
			AND item.kind IN (`+kinds+`)
			AND location.location_type <> 'cache'
			AND location.availability IN ('available', 'remote')
			AND source.enabled = 1
	`, workIDs, nil, func(rows *sql.Rows) error {
		var workID int64
		var locationType string
		var file workLyricsFile
		if err := rows.Scan(&workID, &file.itemID, &file.kind, &locationType, &file.sourceID, &file.path, &file.assignedLyricsItemID); err != nil {
			return err
		}
		// A file stored before its extension was recognized keeps the kind
		// "file"; its path tells what it is.
		if file.kind == "file" {
			file.kind = mediaKindFromPath(file.path)
		}
		file.local = locationType == "local"
		if file.isTrack() || isLyricsMediaKind(file.kind, file.path) || isLyricsMatchPath(file.path) {
			files[workID] = append(files[workID], file)
		}
		return nil
	})
}

// workLyricsStatus reports whether a work's files include a track, and
// whether any track has lyrics.
func workLyricsStatus(files []workLyricsFile) (hasTracks bool, hasLyrics bool) {
	localItems := map[int64]bool{}
	candidates := map[int64][]lyricsCandidateName{}
	for _, file := range files {
		if file.local {
			localItems[file.itemID] = true
		}
		if !file.isTrack() && isLyricsMatchPath(file.path) {
			candidates[file.matchScope()] = append(candidates[file.matchScope()], newLyricsCandidateName(file.path))
		}
	}
	for _, file := range files {
		if !file.isTrack() {
			continue
		}
		hasTracks = true
		// An assignment counts only while its lyrics file is in the library.
		if file.assignedLyricsItemID > 0 && localItems[file.assignedLyricsItemID] {
			return true, true
		}
		track := newLyricsTrackName(file.path)
		for _, candidate := range candidates[file.matchScope()] {
			if candidate.matches(track) {
				return true, true
			}
		}
	}
	return hasTracks, false
}

func (s *Server) enrichTrackedPresenceForkState(ctx context.Context, code string, items []sourcePresenceItem) {
	sourceIDs := []int64{}
	for index := range items {
		if strings.EqualFold(items[index].Type, "tracked") && items[index].FileSourceID > 0 {
			sourceIDs = append(sourceIDs, items[index].FileSourceID)
		}
	}
	sourceIDs = uniquePositiveInt64s(sourceIDs)
	if len(sourceIDs) == 0 {
		return
	}
	familyWorkIDs, err := s.familyWorkIDsForCode(ctx, code)
	if err != nil || len(familyWorkIDs) == 0 {
		return
	}
	workQuery, workArgs := int64InQuery("item.work_id IN (%s)", familyWorkIDs)
	sourceQuery, sourceArgs := int64InQuery("location.file_source_id IN (%s)", sourceIDs)
	args := append(workArgs, sourceArgs...)
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT location.file_source_id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE `+workQuery+`
			AND `+sourceQuery+`
			AND location.location_type = 'remote_stream'
			AND location.availability = 'available'
	`, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	forked := map[int64]bool{}
	for rows.Next() {
		var sourceID int64
		if err := rows.Scan(&sourceID); err != nil {
			return
		}
		forked[sourceID] = true
	}
	if err := rows.Err(); err != nil {
		return
	}
	for index := range items {
		if !strings.EqualFold(items[index].Type, "tracked") || items[index].FileSourceID <= 0 {
			continue
		}
		value := forked[items[index].FileSourceID]
		items[index].Forked = &value
	}
}

func uniquePositiveInt64s(values []int64) []int64 {
	result := make([]int64, 0, len(values))
	seen := map[int64]struct{}{}
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
