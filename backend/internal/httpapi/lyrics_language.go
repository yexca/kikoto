package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

// A library lyrics assignment declares the language of its lyrics file, from
// the languages titles and tag names are saved in. The empty language is the
// assignment for every language. A language is declared by whoever assigns the
// file; it is never inferred from the file's name or text.

// mediaLyricsAssignmentDetail is one library lyrics file of an audio item.
type mediaLyricsAssignmentDetail struct {
	Language          string `json:"language"`
	LyricsMediaItemID int64  `json:"lyricsMediaItemId"`
}

// normalizeLyricsLanguage returns the stored token of a lyrics language and
// false for a language lyrics cannot declare. Blank is the every-language
// assignment; the origin token is a display priority, not a language.
func normalizeLyricsLanguage(value string) (string, bool) {
	if strings.TrimSpace(value) == "" {
		return "", true
	}
	language := dlsite.NormalizeMetadataLanguage(value)
	if language == "" || language == dlsite.OriginMetadataLanguage {
		return "", false
	}
	return language, true
}

// lyricsLanguageFolderName is the folder inside the lyrics folder that holds
// the lyrics Kikoto adds for a language. The fallback lyrics have a folder of
// their own, so a track folder of the work can never sit beside the language
// folders. The names carry no work code, so a scan never mistakes a folder for
// a work of its own.
func lyricsLanguageFolderName(language string) string {
	switch language {
	case "ja-jp":
		return "ja"
	case "en-us":
		return "en"
	case "zh-cn":
		return "zh-hans"
	case "zh-tw":
		return "zh-hant"
	case "ko-kr":
		return "ko"
	default:
		return "fallback"
	}
}

// lyricsLanguageFolderPath is the folder, relative to a work folder, that
// holds the lyrics Kikoto adds for a language.
func lyricsLanguageFolderPath(language string) string {
	return localfs.LyricsRootName + "/" + lyricsLanguageFolderName(language)
}

// lyricsFolderLanguage returns the language whose folder inside the lyrics
// folder has this name, and false for any other folder.
func lyricsFolderLanguage(name string) (string, bool) {
	for _, language := range append([]string{""}, dlsite.SupportedMetadataLanguages...) {
		if lyricsLanguageFolderName(language) == name {
			return language, true
		}
	}
	return "", false
}

// lyricsLanguageOrder ranks lyrics languages for a viewer: the viewer's
// languages in order, where the origin token stands for the work's original
// language when it is known, then the every-language assignment, then the
// remaining languages in the fixed supported order.
func lyricsLanguageOrder(viewer []string, originLanguage string) map[string]int {
	order := map[string]int{}
	add := func(language string) {
		if _, seen := order[language]; !seen {
			order[language] = len(order)
		}
	}
	for _, language := range viewer {
		if language == dlsite.OriginMetadataLanguage {
			if originLanguage == "" {
				continue
			}
			language = originLanguage
		}
		add(language)
	}
	add("")
	for _, language := range dlsite.SupportedMetadataLanguages {
		add(language)
	}
	return order
}

// attachLyricsAssignments gives each audio item its library lyrics files in
// the order this viewer's playback tries them, and names the first as the
// item's assigned lyrics.
func (s *Server) attachLyricsAssignments(ctx context.Context, mediaWorkID int64, mediaItems []mediaItemDetail, itemIndexes map[int64]int) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT assignment.audio_media_item_id, assignment.language, assignment.lyrics_media_item_id
		FROM media_lyrics_assignment AS assignment
		INNER JOIN media_item AS item ON item.id = assignment.audio_media_item_id
		WHERE item.work_id = ?
	`, mediaWorkID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	assigned := []int{}
	for rows.Next() {
		var audioID int64
		var assignment mediaLyricsAssignmentDetail
		if err := rows.Scan(&audioID, &assignment.Language, &assignment.LyricsMediaItemID); err != nil {
			return err
		}
		index, ok := itemIndexes[audioID]
		if !ok {
			continue
		}
		if len(mediaItems[index].LyricsAssignments) == 0 {
			assigned = append(assigned, index)
		}
		mediaItems[index].LyricsAssignments = append(mediaItems[index].LyricsAssignments, assignment)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if len(assigned) == 0 {
		return nil
	}
	order := lyricsLanguageOrder(s.viewerMetadataLanguages(ctx), s.workOriginLyricsLanguage(ctx, mediaWorkID))
	for _, index := range assigned {
		assignments := mediaItems[index].LyricsAssignments
		sort.SliceStable(assignments, func(i, j int) bool {
			return order[assignments[i].Language] < order[assignments[j].Language]
		})
		first := assignments[0].LyricsMediaItemID
		mediaItems[index].AssignedLyricsMediaItemID = &first
	}
	return nil
}

// workOriginLyricsLanguage is the declared language of the original edition
// of the work's family, or empty when it is unknown or not a lyrics language.
func (s *Server) workOriginLyricsLanguage(ctx context.Context, workID int64) string {
	var language string
	err := s.db.QueryRowContext(ctx, `
		SELECT canonical.metadata_language
		FROM work_edition AS edition
		INNER JOIN work_edition AS canonical ON canonical.logical_work_id = edition.logical_work_id
			AND canonical.is_canonical = 1
		WHERE edition.work_id = ?
		ORDER BY canonical.work_id
		LIMIT 1
	`, workID).Scan(&language)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) && ctx.Err() == nil {
			slog.Warn("read original edition language", "work_id", workID, "error", err)
		}
		return ""
	}
	normalized, ok := normalizeLyricsLanguage(dlsite.EditionMetadataLanguage(language))
	if !ok {
		return ""
	}
	return normalized
}
