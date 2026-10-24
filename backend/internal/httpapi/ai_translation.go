package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode"
)

// Translate with AI translates one work into one or more target languages.
// One submission is one workflow run with one job; its translation_item rows
// are the units that run, wait for review and are accepted or rejected one by
// one: a work's title or description, a shared tag name, a file or folder
// display name, or the lyrics of one track. Lyrics of a track without any are
// first transcribed by a speech recognition service in the same run.

const (
	aiTranslationWorkflowCode = "ai_translation"
	aiTranslationWorkerType   = "ai_translation"
	// aiTranslationMaxNames bounds the display names one run translates.
	aiTranslationMaxNames = 2000
	// aiTranslationNameBatch and aiTranslationNameBatchBytes bound the names
	// one request carries.
	aiTranslationNameBatch      = 64
	aiTranslationNameBatchBytes = 8 << 10
	// aiTranslationNameBytes is the longest name sent; a translated name is a
	// tag-sized entry.
	aiTranslationNameBytes = 512
	aiTranslationMaxLyrics = 500
)

// Item categories. The dialog's "files" category covers file and folder names.
const (
	translationTitle       = "title"
	translationDescription = "description"
	translationTag         = "tag"
	translationFileName    = "file_name"
	translationFolderName  = "folder_name"
	translationLyrics      = "lyrics"
)

// translationItemDetail holds what one category needs to run and to be
// accepted.
type translationItemDetail struct {
	// MediaWorkID is the work whose local files a display name or lyrics item
	// belongs to.
	MediaWorkID int64 `json:"mediaWorkId,omitempty"`
	// Path is a file or folder below the work folder.
	Path string `json:"path,omitempty"`
	// SourceLocationID is the lyrics file a lyrics translation reads.
	SourceLocationID int64  `json:"sourceLocationId,omitempty"`
	SourceTitle      string `json:"sourceTitle,omitempty"`
	FolderID         int64  `json:"folderId,omitempty"`
	// Extension is the extension the published lyrics file takes.
	Extension string `json:"extension,omitempty"`
	// SourceLanguage is the language the source text is in, or empty when
	// unknown.
	SourceLanguage string `json:"sourceLanguage,omitempty"`
	// Chunks is how many requests a lyrics item takes.
	Chunks int `json:"chunks,omitempty"`
	// ASRModel is the speech model of lyrics read from a transcription.
	ASRModel string `json:"asrModel,omitempty"`
	// SourceWorkID is the work whose original edition supplied a title or
	// description.
	SourceWorkID int64 `json:"sourceWorkId,omitempty"`
	// AppliedPath is the lyrics file an accepted lyrics item became.
	AppliedPath string `json:"appliedPath,omitempty"`
}

type translationItem struct {
	ID              int64
	RunID           int64
	WorkID          int64
	UserID          int64
	Language        string
	Category        string
	Subject         string
	Engine          string
	State           string
	FailureCode     string
	TranscriptionID string
	Detail          translationItemDetail
	SourceText      string
	SourceHash      string
	ResultText      string
	Checkpoint      []string
	RequestIndex    int
	ProviderID      string
	Model           string
	ConfigHash      string
	PolicyHash      string
}

const translationItemColumns = `item.id, item.workflow_run_id, item.work_id, COALESCE(item.requested_by_user_id, 0), item.language,
	item.category, item.subject, item.engine, item.state, item.failure_code, COALESCE(item.asr_transcription_id, ''),
	item.detail_json, item.source_text, item.source_hash, item.result_text, item.checkpoint_json, item.request_index,
	item.provider_id, item.model, item.config_hash, item.policy_hash`

type rowScanner interface{ Scan(...any) error }

func scanTranslationItem(row rowScanner) (translationItem, error) {
	var item translationItem
	var detail, checkpoint string
	if err := row.Scan(&item.ID, &item.RunID, &item.WorkID, &item.UserID, &item.Language, &item.Category, &item.Subject,
		&item.Engine, &item.State, &item.FailureCode, &item.TranscriptionID, &detail, &item.SourceText, &item.SourceHash,
		&item.ResultText, &checkpoint, &item.RequestIndex, &item.ProviderID, &item.Model, &item.ConfigHash, &item.PolicyHash); err != nil {
		return item, err
	}
	if err := json.Unmarshal([]byte(detail), &item.Detail); err != nil {
		return item, err
	}
	if checkpoint != "" && checkpoint != "{}" {
		if err := json.Unmarshal([]byte(checkpoint), &item.Checkpoint); err != nil {
			return item, err
		}
	}
	return item, nil
}

type translationItemQuerier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func loadTranslationItems(ctx context.Context, q translationItemQuerier, where string, args ...any) ([]translationItem, error) {
	rows, err := q.QueryContext(ctx, "SELECT "+translationItemColumns+" FROM translation_item AS item WHERE "+where, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []translationItem{}
	for rows.Next() {
		item, err := scanTranslationItem(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// translationDedupKey names the object an item translates. A shared tag name
// is one object in the whole library; everything else belongs to its work.
func translationDedupKey(language, category string, workID int64, subject string) string {
	if category == translationTag {
		return fmt.Sprintf("%s|%s|%s", language, category, subject)
	}
	return fmt.Sprintf("%s|%s|%d|%s", language, category, workID, subject)
}

// translationCategoryPermissions are what requesting, running and accepting
// an item of a category needs.
func translationCategoryPermissions(category string) []string {
	switch category {
	case translationTitle, translationDescription, translationTag:
		return []string{"metadata:sync", "library:write"}
	}
	return []string{"library:write"}
}

// canUseTranslationCenter reports whether an account may open the
// Translation page: it can translate at least one category.
func canUseTranslationCenter(user currentUser) bool {
	return userHasPermission(user, "library:write")
}

func hasTranslationPermissions(user currentUser, category string) bool {
	for _, permission := range translationCategoryPermissions(category) {
		if !userHasPermission(user, permission) {
			return false
		}
	}
	return true
}

// nameMarkerWords are words a file name holds for numbering rather than
// meaning; a name made only of them, numbers and punctuation is not
// translated.
var nameMarkerWords = regexp.MustCompile(`(?i)\b(?:track|tr|disc|cd|part|pt|no|ver|vol|se|bgm|mp3|wav|flac|m4a|ogg|opus|aac)\b`)

// translatableName reports whether a display name has words to translate.
func translatableName(name string) bool {
	// Markers are removed before and after numbers, as in "mp3" and "Track1".
	name = nameMarkerWords.ReplaceAllString(name, " ")
	name = strings.Map(func(r rune) rune {
		if unicode.IsDigit(r) {
			return ' '
		}
		return r
	}, name)
	name = nameMarkerWords.ReplaceAllString(name, " ")
	return strings.IndexFunc(name, unicode.IsLetter) >= 0
}

// displayNameSource is the real name a display name replaces: a file's name
// without its extension, or a folder's name.
func displayNameSource(relative string, file bool) string {
	name := path.Base(relative)
	if file {
		name = strings.TrimSuffix(name, path.Ext(name))
	}
	return name
}

// nameBatches splits names into requests of at most aiTranslationNameBatch
// names and aiTranslationNameBatchBytes bytes, in order.
func nameBatches(names []string) [][2]int {
	batches := [][2]int{}
	start, size := 0, 0
	for index, name := range names {
		if index > start && (index-start >= aiTranslationNameBatch || size+len(name) > aiTranslationNameBatchBytes) {
			batches = append(batches, [2]int{start, index})
			start, size = index, 0
		}
		size += len(name)
	}
	if start < len(names) {
		batches = append(batches, [2]int{start, len(names)})
	}
	return batches
}
