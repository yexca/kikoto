package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

// translationCandidate is one object a run could translate: it has no value
// in the target language yet.
type translationCandidate struct {
	WorkID     int64
	Category   string
	Subject    string
	SourceText string
	Detail     translationItemDetail
}

func (c translationCandidate) key(language string) string {
	return translationDedupKey(language, c.Category, c.WorkID, c.Subject)
}

// translationPlanCategory is what one language lacks in one category.
type translationPlanCategory struct {
	// Missing counts the objects without a value in the language that no
	// item is translating or waiting with.
	Missing int `json:"missing"`
	// Active counts the objects an item is translating or waiting with.
	Active int `json:"active"`
	// Characters is the length of the missing source text.
	Characters int `json:"characters"`
	// OtherWorks counts the active shared tag names another work's run
	// requested.
	OtherWorks int `json:"otherWorks,omitempty"`
	// AffectedWorks counts the works that show the missing shared tag names.
	AffectedWorks int `json:"affectedWorks,omitempty"`
	// Skipped counts names left out because they have nothing to translate
	// or are too long.
	Skipped int `json:"skipped,omitempty"`
}

type translationPlanLanguage struct {
	Language    string                  `json:"language"`
	Title       translationPlanCategory `json:"title"`
	Description translationPlanCategory `json:"description"`
	Tags        translationPlanCategory `json:"tags"`
	Files       translationPlanCategory `json:"files"`
	// Lyrics lists the tracks whose lyrics in the language are being
	// translated or wait for review.
	Lyrics []translationPlanTrack `json:"lyrics"`
}

type translationPlanTrack struct {
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	State            string `json:"state"`
}

// translationPlanPermissions name the categories the viewer may request.
type translationPlanPermissions struct {
	Metadata bool `json:"metadata"`
	Files    bool `json:"files"`
	Lyrics   bool `json:"lyrics"`
}

type translationPlanResponse struct {
	WorkID         int64                      `json:"workId"`
	OriginLanguage string                     `json:"originLanguage"`
	Permissions    translationPlanPermissions `json:"permissions"`
	Languages      []translationPlanLanguage  `json:"languages"`
	// Transcribing lists the tracks with a transcription that is running.
	Transcribing []int64 `json:"transcribing"`
	// AttributionEnabled reports whether AI-made lyrics files open with a
	// line naming their models.
	AttributionEnabled bool `json:"attributionEnabled"`
	// AutoAccept reports whether finished items are accepted automatically.
	AutoAccept bool `json:"autoAccept"`
}

// translationPlanLanguages reads the target languages of a request.
func translationPlanLanguages(raw []string) ([]string, bool) {
	languages := []string{}
	for _, language := range raw {
		language = strings.TrimSpace(language)
		if language == "" {
			continue
		}
		if !slices.Contains(dlsite.SupportedMetadataLanguages, language) {
			return nil, false
		}
		if !slices.Contains(languages, language) {
			languages = append(languages, language)
		}
	}
	return languages, len(languages) > 0
}

func (s *Server) getAITranslationPlan(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	languages, ok := translationPlanLanguages(strings.Split(r.URL.Query().Get("languages"), ","))
	if !ok {
		writeAPIError(w, 400, "invalid_translation_request", "Choose supported target languages.", false)
		return
	}
	plan, err := s.planAITranslation(r.Context(), actor, workID, languages)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "work_not_found", "Work not found.", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, plan)
}

func (s *Server) planAITranslation(ctx context.Context, actor currentUser, workID int64, languages []string) (translationPlanResponse, error) {
	response := translationPlanResponse{WorkID: workID, Languages: []translationPlanLanguage{}, Transcribing: []int64{}}
	var exists int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE id = ?", workID).Scan(&exists); err != nil {
		return response, err
	}
	response.OriginLanguage = s.workOriginLyricsLanguage(ctx, workID)
	response.Permissions = translationPlanPermissions{
		Metadata: hasTranslationPermissions(actor, translationTitle),
		Files:    hasTranslationPermissions(actor, translationFileName),
		Lyrics:   hasTranslationPermissions(actor, translationLyrics),
	}
	enabled, err := s.lyricsAttributionEnabled(ctx)
	if err != nil {
		return response, err
	}
	response.AttributionEnabled = enabled
	settings, err := s.translationSettings(ctx)
	if err != nil {
		return response, err
	}
	response.AutoAccept = settings.AutoAccept
	candidates, err := s.translationCandidates(ctx, workID, languages, []string{translationTitle, translationDescription, translationTag, translationFileName, translationFolderName})
	if err != nil {
		return response, err
	}
	keys := []string{}
	for _, language := range languages {
		for _, candidate := range candidates.byLanguage[language] {
			keys = append(keys, candidate.key(language))
		}
	}
	active, err := s.activeTranslationKeys(ctx, keys)
	if err != nil {
		return response, err
	}
	mediaWorkID, err := s.resolveMediaWorkIDForRequest(ctx, workID)
	if err != nil {
		return response, err
	}
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return response, err
	}
	for _, language := range languages {
		entry := translationPlanLanguage{Language: language, Lyrics: []translationPlanTrack{}}
		tagIDs := []string{}
		for _, candidate := range candidates.byLanguage[language] {
			var category *translationPlanCategory
			switch candidate.Category {
			case translationTitle:
				category = &entry.Title
			case translationDescription:
				category = &entry.Description
			case translationTag:
				category = &entry.Tags
			default:
				category = &entry.Files
			}
			if state, ok := active[candidate.key(language)]; ok {
				category.Active++
				if candidate.Category == translationTag && state.workID != workID {
					category.OtherWorks++
				}
				continue
			}
			category.Missing++
			category.Characters += utf8.RuneCountInString(candidate.SourceText)
			if candidate.Category == translationTag {
				tagIDs = append(tagIDs, candidate.Subject)
			}
		}
		entry.Files.Skipped = candidates.skippedNames[language]
		if len(tagIDs) > 0 {
			if err := s.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT work_id) FROM work_tag WHERE tag_id IN ("+strings.TrimSuffix(strings.Repeat("?,", len(tagIDs)), ",")+")", stringsToAny(tagIDs)...).Scan(&entry.Tags.AffectedWorks); err != nil {
				return response, err
			}
		}
		// A title or description with an active item counts as present.
		for _, category := range []*translationPlanCategory{&entry.Title, &entry.Description} {
			if category.Active > 0 {
				category.Missing = 0
			}
		}
		response.Languages = append(response.Languages, entry)
	}
	ids := make([]any, 0, len(family)+1)
	for id := range family {
		ids = append(ids, id)
	}
	ids = append(ids, mediaWorkID)
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := s.db.QueryContext(ctx, `SELECT language, CAST(subject AS INTEGER), state FROM translation_item
		WHERE category = 'lyrics' AND work_id IN (`+marks+`) AND state IN ('queued', 'waiting_transcription', 'requesting', 'ready', 'uncertain')`, ids...)
	if err != nil {
		return response, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var language, state string
		var audioID int64
		if err := rows.Scan(&language, &audioID, &state); err != nil {
			return response, err
		}
		for index := range response.Languages {
			if response.Languages[index].Language == language {
				response.Languages[index].Lyrics = append(response.Languages[index].Lyrics, translationPlanTrack{audioID, state})
			}
		}
	}
	if err := rows.Err(); err != nil {
		return response, err
	}
	transcribing, err := s.db.QueryContext(ctx, `SELECT DISTINCT audio_media_item_id FROM asr_transcription
		WHERE work_id IN (`+marks+`) AND state IN ('pending', 'requesting')`, ids...)
	if err != nil {
		return response, err
	}
	defer func() { _ = transcribing.Close() }()
	for transcribing.Next() {
		var audioID int64
		if err := transcribing.Scan(&audioID); err != nil {
			return response, err
		}
		response.Transcribing = append(response.Transcribing, audioID)
	}
	return response, transcribing.Err()
}

func stringsToAny(values []string) []any {
	result := make([]any, len(values))
	for index, value := range values {
		result[index] = value
	}
	return result
}

type translationCandidates struct {
	byLanguage   map[string][]translationCandidate
	skippedNames map[string]int
}

// translationCandidates lists, per language, the objects of the categories
// that have no value in that language. Titles and descriptions are missing
// when no edition, manual value or accepted translation provides one; a tag
// when no shared name does; a display name when the file or folder has none
// and its real name, in another language than the target, has words.
func (s *Server) translationCandidates(ctx context.Context, workID int64, languages, categories []string) (translationCandidates, error) {
	result := translationCandidates{byLanguage: map[string][]translationCandidate{}, skippedNames: map[string]int{}}
	wants := func(category string) bool { return slices.Contains(categories, category) }
	var input llmWorkInput
	if wants(translationTitle) || wants(translationDescription) {
		var err error
		if input, err = loadLLMWorkInput(ctx, s.db, workID); err != nil {
			return result, err
		}
	}
	origin := s.workOriginLyricsLanguage(ctx, workID)
	var mediaWorkID int64
	var files []fileDisplayNameEntry
	var folders []string
	var fileNames map[int64]map[string]string
	var folderNames map[string]map[string]string
	if wants(translationFileName) || wants(translationFolderName) {
		var err error
		if mediaWorkID, err = s.resolveMediaWorkIDForRequest(ctx, workID); err != nil {
			return result, err
		}
		if files, folders, err = s.localDisplayNameEntries(ctx, mediaWorkID); err != nil {
			return result, err
		}
		if fileNames, err = s.mediaItemDisplayNames(ctx, mediaWorkID); err != nil {
			return result, err
		}
		if folderNames, err = s.workFolderDisplayNames(ctx, mediaWorkID); err != nil {
			return result, err
		}
	}
	for _, language := range languages {
		list := []translationCandidate{}
		if wants(translationTitle) || wants(translationDescription) {
			coverage, err := newTranslationCoverageSQL(ctx, s, language)
			if err != nil {
				return result, err
			}
			states, err := s.loadTranslationCoverage(ctx, coverage, []libraryWorkSummary{{ID: workID}})
			if err != nil {
				return result, err
			}
			state := states[workID]
			if wants(translationTitle) && state.Title == "missing" && strings.TrimSpace(input.Text.Title) != "" {
				list = append(list, translationCandidate{WorkID: workID, Category: translationTitle, SourceText: input.Text.Title, Detail: translationItemDetail{SourceWorkID: input.SourceID, SourceLanguage: origin}})
			}
			if wants(translationDescription) && state.Description == "missing" && strings.TrimSpace(input.Text.Description) != "" {
				list = append(list, translationCandidate{WorkID: workID, Category: translationDescription, SourceText: input.Text.Description, Detail: translationItemDetail{SourceWorkID: input.SourceID, SourceLanguage: origin}})
			}
		}
		if wants(translationTag) {
			ids, names, err := loadLLMTagCandidates(ctx, s.db, workID, language)
			if err != nil {
				return result, llmInvalid("llm_input_too_large", "Shared tag input exceeds the translation limit.")
			}
			for index, id := range ids {
				list = append(list, translationCandidate{WorkID: workID, Category: translationTag, Subject: strconv.FormatInt(id, 10), SourceText: names[index], Detail: translationItemDetail{SourceLanguage: origin}})
			}
		}
		// Real names are in the original language already.
		if language != origin {
			if wants(translationFolderName) {
				for _, folder := range folders {
					if isManagedLyricsPath(folder) || folderNames[folder][language] != "" {
						continue
					}
					name := displayNameSource(folder, false)
					if !translatableName(name) || len(name) > aiTranslationNameBytes {
						result.skippedNames[language]++
						continue
					}
					list = append(list, translationCandidate{WorkID: mediaWorkID, Category: translationFolderName, Subject: folder, SourceText: name, Detail: translationItemDetail{MediaWorkID: mediaWorkID, Path: folder, SourceLanguage: origin}})
				}
			}
			if wants(translationFileName) {
				for _, file := range files {
					if isManagedLyricsPath(file.Path) || fileNames[file.MediaItemID][language] != "" {
						continue
					}
					name := displayNameSource(file.Path, true)
					if !translatableName(name) || len(name) > aiTranslationNameBytes {
						result.skippedNames[language]++
						continue
					}
					list = append(list, translationCandidate{WorkID: mediaWorkID, Category: translationFileName, Subject: strconv.FormatInt(file.MediaItemID, 10), SourceText: name, Detail: translationItemDetail{MediaWorkID: mediaWorkID, Path: file.Path, SourceLanguage: origin}})
				}
			}
		}
		result.byLanguage[language] = list
	}
	return result, nil
}

// isManagedLyricsPath reports whether a path lies in the lyrics folder Kikoto
// manages, whose language folders keep their own names.
func isManagedLyricsPath(relative string) bool {
	return relative == localfs.LyricsRootName || strings.HasPrefix(relative, localfs.LyricsRootName+"/")
}

type activeTranslation struct {
	state  string
	workID int64
}

// activeTranslationKeys returns the keys with an item that is queued,
// running, uncertain or waiting for review.
func (s *Server) activeTranslationKeys(ctx context.Context, keys []string) (map[string]activeTranslation, error) {
	result := map[string]activeTranslation{}
	for start := 0; start < len(keys); start += 500 {
		batch := keys[start:min(start+500, len(keys))]
		rows, err := s.db.QueryContext(ctx, `SELECT dedup_key, state, work_id FROM translation_item
			WHERE state IN ('queued', 'waiting_transcription', 'requesting', 'ready', 'uncertain')
				AND dedup_key IN (`+strings.TrimSuffix(strings.Repeat("?,", len(batch)), ",")+`)`, stringsToAny(batch)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var key string
			var item activeTranslation
			if err := rows.Scan(&key, &item.state, &item.workID); err != nil {
				_ = rows.Close()
				return nil, err
			}
			result[key] = item
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return result, nil
}
