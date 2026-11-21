package httpapi

import (
	"context"
	"database/sql"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/naturalorder"
)

// lyricsEditPlannedAssignment is an added file the edit assigns to a track of
// the edited folder, in the file's language.
type lyricsEditPlannedAssignment struct {
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	ItemKey          string `json:"itemKey"`

	item int
}

// lyricsEditAudio is a local audio file of the edited folder, by its path
// below the folder.
type lyricsEditAudio struct {
	id     int64
	path   string
	folder string
	title  string
	// languages are the languages the track has library lyrics in.
	languages map[string]bool
}

// lyricsEditOrderFile is a file that order alignment pairs with a track.
type lyricsEditOrderFile struct {
	index  int
	path   string
	folder string
	title  string
}

// lyricsEditAutomaticAssignments pairs the files the edit adds with the tracks
// of the edited folder that have no library lyrics in the file's language.
func (s *Server) lyricsEditAutomaticAssignments(ctx context.Context, target lyricsFetchTarget, items []lyricsEditItem) ([]lyricsEditPlannedAssignment, error) {
	audio, err := s.lyricsEditFolderAudio(ctx, target)
	if err != nil {
		return nil, err
	}
	return pairLyricsEditFiles(audio, items), nil
}

// pairLyricsEditFiles pairs added files with tracks. Files of one place in one
// language are paired together, so track order means something: a track
// takes the file name matching picks for it, and the tracks name matching
// leaves are aligned by track order with the subfolder holding the most of
// the place's files. A track that has library lyrics in a file's language
// keeps them, a file the plan leaves out is not assigned, and a track takes at
// most one file per language.
func pairLyricsEditFiles(audio []lyricsEditAudio, items []lyricsEditItem) []lyricsEditPlannedAssignment {
	if len(audio) == 0 {
		return nil
	}
	groups := [][]int{}
	groupIndexes := map[string]int{}
	for index, item := range items {
		if !lyricsEditItemAdds(item) && item.Action != "skip" {
			continue
		}
		key := item.Language + "\n" + strings.TrimSuffix(item.ItemKey, item.Path)
		group, ok := groupIndexes[key]
		if !ok {
			group = len(groups)
			groupIndexes[key] = group
			groups = append(groups, nil)
		}
		groups[group] = append(groups[group], index)
	}
	taken := map[string]bool{}
	assignments := []lyricsEditPlannedAssignment{}
	for _, group := range groups {
		language := items[group[0]].Language
		free := []lyricsEditAudio{}
		for _, entry := range audio {
			if !entry.languages[language] && !taken[strconv.FormatInt(entry.id, 10)+":"+language] {
				free = append(free, entry)
			}
		}
		if len(free) == 0 {
			continue
		}
		candidates := make([]lyricsMatchCandidate, len(group))
		files := make([]lyricsEditOrderFile, len(group))
		for position, index := range group {
			candidates[position] = newLyricsMatchCandidate(items[index].Path)
			files[position] = lyricsEditOrderFile{
				index: index, path: items[index].Path,
				folder: lyricsEditDirectory(items[index].Path), title: path.Base(items[index].Path),
			}
		}
		paired := make(map[int64]int, len(free))
		unmatched := []lyricsEditAudio{}
		for _, entry := range free {
			if matches := rankLyricsMatches(entry.path, candidates); len(matches) > 0 {
				paired[entry.id] = group[matches[0].index]
			} else {
				unmatched = append(unmatched, entry)
			}
		}
		for audioID, index := range alignLyricsEditByOrder(unmatched, files, largestLyricsFolder(files)) {
			paired[audioID] = index
		}
		for _, entry := range free {
			index, ok := paired[entry.id]
			if !ok {
				continue
			}
			taken[strconv.FormatInt(entry.id, 10)+":"+language] = true
			assignments = append(assignments, lyricsEditPlannedAssignment{AudioMediaItemID: entry.id, ItemKey: items[index].ItemKey, item: index})
		}
	}
	return assignments
}

func newLyricsEditAudio(id int64, relative string, languages ...string) lyricsEditAudio {
	entry := lyricsEditAudio{
		id: id, path: relative, folder: lyricsEditDirectory(relative), title: path.Base(relative),
		languages: map[string]bool{},
	}
	for _, language := range languages {
		entry.languages[language] = true
	}
	return entry
}

// lyricsEditFolderAudio lists the available local audio files of the edited
// folder in natural path order, each with the languages it has library
// lyrics in.
func (s *Server) lyricsEditFolderAudio(ctx context.Context, target lyricsFetchTarget) ([]lyricsEditAudio, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT item.id, item.kind, location.path
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.work_id = ?
			AND item.kind IN ('audio', 'file')
			AND location.location_type = 'local'
			AND location.availability = 'available'
		ORDER BY item.id, location.id
	`, target.WorkID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	audio := []lyricsEditAudio{}
	indexes := map[int64]int{}
	for rows.Next() {
		var id int64
		var kind, libraryPath string
		if err := rows.Scan(&id, &kind, &libraryPath); err != nil {
			return nil, err
		}
		if _, listed := indexes[id]; listed || (kind == "file" && mediaKindFromPath(libraryPath) != "audio") {
			continue
		}
		libraryPath = normalizeFolderRootPath(libraryPath)
		relative := strings.TrimPrefix(libraryPath, target.RootPath+"/")
		if target.RootPath == "" || relative == libraryPath {
			continue
		}
		indexes[id] = len(audio)
		audio = append(audio, newLyricsEditAudio(id, relative))
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(audio) == 0 {
		return audio, nil
	}
	ids := make([]int64, 0, len(audio))
	for _, entry := range audio {
		ids = append(ids, entry.id)
	}
	if err := s.queryInt64Batches(ctx, `
		SELECT audio_media_item_id, language
		FROM media_lyrics_assignment
		WHERE audio_media_item_id IN (%s)
	`, ids, nil, func(rows *sql.Rows) error {
		var id int64
		var language string
		if err := rows.Scan(&id, &language); err != nil {
			return err
		}
		audio[indexes[id]].languages[language] = true
		return nil
	}); err != nil {
		return nil, err
	}
	sort.SliceStable(audio, func(i, j int) bool { return naturalorder.Compare(audio[i].path, audio[j].path) < 0 })
	return audio, nil
}

// largestLyricsFolder returns the folder holding the most files, the first
// in natural order among equals.
func largestLyricsFolder(files []lyricsEditOrderFile) string {
	counts := map[string]int{}
	for _, file := range files {
		counts[file.folder]++
	}
	best, bestCount := "", 0
	for folder, count := range counts {
		if count > bestCount || (count == bestCount && naturalorder.Compare(folder, best) < 0) {
			best, bestCount = folder, count
		}
	}
	return best
}

// alignLyricsEditByOrder pairs each folder of tracks with the files of one
// folder by track order, returning the plan item index per audio item. When
// every file on both sides starts with a distinct track number, numbers are
// matched; otherwise a folder is paired by position only when the counts are
// equal. Translated editions rename files, so their names cannot be compared.
func alignLyricsEditByOrder(audio []lyricsEditAudio, files []lyricsEditOrderFile, lyricsFolder string) map[int64]int {
	result := map[int64]int{}
	candidates := []lyricsEditOrderFile{}
	for _, file := range files {
		if file.folder == lyricsFolder {
			candidates = append(candidates, file)
		}
	}
	if len(candidates) == 0 {
		return result
	}
	sort.SliceStable(candidates, func(i, j int) bool { return naturalorder.Compare(candidates[i].path, candidates[j].path) < 0 })
	lyricsByNumber := uniqueLeadingTrackNumbers(len(candidates), func(index int) string { return candidates[index].title })
	folders := []string{}
	byFolder := map[string][]lyricsEditAudio{}
	for _, entry := range audio {
		if _, ok := byFolder[entry.folder]; !ok {
			folders = append(folders, entry.folder)
		}
		byFolder[entry.folder] = append(byFolder[entry.folder], entry)
	}
	for _, folder := range folders {
		entries := append([]lyricsEditAudio{}, byFolder[folder]...)
		sort.SliceStable(entries, func(i, j int) bool { return naturalorder.Compare(entries[i].path, entries[j].path) < 0 })
		audioByNumber := uniqueLeadingTrackNumbers(len(entries), func(index int) string { return entries[index].title })
		switch {
		case lyricsByNumber != nil && audioByNumber != nil:
			for number, audioIndex := range audioByNumber {
				if lyricsIndex, ok := lyricsByNumber[number]; ok {
					result[entries[audioIndex].id] = candidates[lyricsIndex].index
				}
			}
		case len(entries) == len(candidates):
			for position, entry := range entries {
				result[entry.id] = candidates[position].index
			}
		}
	}
	return result
}

// uniqueLeadingTrackNumbers maps each leading track number to the position of
// the name that starts with it, or returns nil when a name has none or two
// names share one.
func uniqueLeadingTrackNumbers(count int, title func(int) string) map[int]int {
	result := make(map[int]int, count)
	for index := range count {
		number, ok := leadingTrackNumber(title(index))
		if _, duplicate := result[number]; !ok || duplicate {
			return nil
		}
		result[number] = index
	}
	return result
}

var leadingTrackNumberPattern = regexp.MustCompile(`(?i)^[` + lyricsNameSpace + `]*(?:track|tr)?[` + lyricsNameSpace + `_.\-#]*([0-9]+)`)

// leadingTrackNumber reads the track number a name starts with, such as 3 in
// "03 Opening" or "Track_3", up to three digits after leading zeros.
func leadingTrackNumber(name string) (int, bool) {
	match := leadingTrackNumberPattern.FindStringSubmatch(name)
	if match == nil {
		return 0, false
	}
	digits := strings.TrimLeft(match[1], "0")
	if digits == "" {
		digits = "0"
	}
	if len(digits) > 3 {
		return 0, false
	}
	number, err := strconv.Atoi(digits)
	return number, err == nil
}

func lyricsEditDirectory(relative string) string {
	if index := strings.LastIndex(relative, "/"); index >= 0 {
		return relative[:index]
	}
	return ""
}
