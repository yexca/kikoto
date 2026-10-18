package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"strings"
)

// workFolderEditAssignment names an added lyrics file, by its item key, as the
// library lyrics of an audio file in the lyrics' language. The audio is a
// media item of the edited work, or a path below the edited folder for audio
// that is indexed only once the edit has run.
type workFolderEditAssignment struct {
	AudioMediaItemID int64  `json:"audioMediaItemId,omitempty"`
	AudioPath        string `json:"audioPath,omitempty"`
	ItemKey          string `json:"itemKey"`
}

// applyWorkFolderEditLyricsRole makes an addition with a declared language a
// lyrics file of that language: only a lyrics text file qualifies, and it goes
// to the language's folder inside the lyrics folder, keeping its path below
// any lyrics folder it already is in.
func applyWorkFolderEditLyricsRole(item *workFolderEditItem, declared *string, rootPath string) error {
	if declared == nil {
		return nil
	}
	if mediaKindFromPath(item.Path) != "text" {
		return lyricsFetchBadRequest("only lyrics text files can be added as lyrics")
	}
	language, ok := normalizeLyricsLanguage(*declared)
	if !ok {
		return lyricsFetchBadRequest("unsupported lyrics language")
	}
	if item.SizeBytes != nil && *item.SizeBytes > maxLyricsFetchFileBytes {
		return lyricsFetchBadRequest("a lyrics file is too large")
	}
	item.Language = &language
	item.Kind = "text"
	item.TargetPath = path.Join(rootPath, lyricsLanguageFolderPath(language), lyricsFolderRelativePath(item.Path))
	return nil
}

func workFolderEditAddsLyrics(items []workFolderEditItem) bool {
	for _, item := range items {
		if item.Language != nil {
			return true
		}
	}
	return false
}

// workFolderEditItemDecision keeps a renamed lyrics file in the lyrics folder
// of its language; any other decision applies as it is.
func workFolderEditItemDecision(item workFolderEditItem, decision remoteFetchFileDecision, rootPath string) (remoteFetchFileDecision, error) {
	if item.Language == nil || !strings.EqualFold(strings.TrimSpace(decision.Resolution), "rename") {
		return decision, nil
	}
	renamed, err := lyricsEditRenameTarget(rootPath, lyricsLanguageFolderPath(*item.Language), decision.TargetPath)
	if err != nil {
		return decision, err
	}
	decision.TargetPath = renamed
	return decision, nil
}

// workFolderEditAssignments validates the requested assignments against the
// plan. A track takes one file per language, and only a lyrics file the edit
// adds or finds already in place can be assigned; one the plan leaves out is
// skipped.
func (s *Server) workFolderEditAssignments(ctx context.Context, plan workFolderEditPlan, requested []workFolderEditAssignment) ([]workFolderEditAssignment, error) {
	if len(requested) > maxLyricsAssignmentChanges {
		return nil, invalidRequestError(fmt.Sprintf("at most %d assignments can be saved at once", maxLyricsAssignmentChanges))
	}
	byKey := make(map[string]workFolderEditItem, len(plan.Items))
	for _, item := range plan.Items {
		byKey[item.ItemKey] = item
	}
	audio := map[int64]string{}
	taken := map[string]bool{}
	assignments := make([]workFolderEditAssignment, 0, len(requested))
	for _, assignment := range requested {
		assignment.ItemKey = strings.TrimSpace(assignment.ItemKey)
		item, ok := byKey[assignment.ItemKey]
		if !ok || item.Language == nil {
			return nil, invalidRequestError("each assignment must name one of the added lyrics files")
		}
		if !workFolderEditItemAdds(item) && item.Action != "skip" {
			continue
		}
		var slot string
		switch {
		case assignment.AudioMediaItemID > 0 && assignment.AudioPath == "":
			audio[assignment.AudioMediaItemID] = ""
			slot = fmt.Sprintf("id:%d", assignment.AudioMediaItemID)
		case assignment.AudioMediaItemID == 0 && assignment.AudioPath != "":
			assignment.AudioPath = cleanRemoteRelativePath(assignment.AudioPath)
			if assignment.AudioPath == "" || mediaKindFromPath(assignment.AudioPath) != "audio" {
				return nil, invalidRequestError("an assignment must name an audio file of the folder")
			}
			slot = "path:" + fetchTargetKey(assignment.AudioPath)
		default:
			return nil, invalidRequestError("each assignment must name an audio item or an audio path")
		}
		slot += "\n" + *item.Language
		if taken[slot] {
			return nil, invalidRequestError("each audio file can be assigned only once per language")
		}
		taken[slot] = true
		assignments = append(assignments, assignment)
	}
	if err := s.validateLyricsFetchAudio(ctx, plan.WorkID, audio); err != nil {
		return nil, err
	}
	return assignments, nil
}

// declareWorkFolderEditAssignments stores the assignments once the folder is
// indexed. An audio or lyrics file the index does not hold is skipped, not an
// error: the files themselves changed.
func (s *Server) declareWorkFolderEditAssignments(ctx context.Context, payload workFolderEditJobPayload) (int, error) {
	if len(payload.Assignments) == 0 {
		return 0, nil
	}
	target := lyricsFetchTarget{WorkID: payload.WorkID, FileSourceID: payload.FileSourceID, RootPath: payload.TargetRoot}
	byKey := make(map[string]workFolderEditItem, len(payload.Items))
	for _, item := range payload.Items {
		byKey[item.ItemKey] = item
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	assigned := 0
	for _, assignment := range payload.Assignments {
		item, ok := byKey[assignment.ItemKey]
		if !ok || item.Language == nil {
			continue
		}
		lyricsID, ok, err := lyricsEditLyricsItem(ctx, tx, target, item.TargetPath)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		audioID := assignment.AudioMediaItemID
		if audioID == 0 {
			if audioID, ok, err = workFolderEditAudioItem(ctx, tx, target, path.Join(target.RootPath, assignment.AudioPath)); err != nil {
				return 0, err
			} else if !ok {
				continue
			}
		}
		if err := upsertLyricsAssignment(ctx, tx, audioID, *item.Language, lyricsID, workFolderEditAssignmentOrigin(item), payload.ActorUserID); err != nil {
			return 0, err
		}
		assigned++
	}
	return assigned, tx.Commit()
}

// workFolderEditAudioItem returns the audio media item of the available local
// file at a library path of the edited folder.
func workFolderEditAudioItem(ctx context.Context, tx *sql.Tx, target lyricsFetchTarget, libraryPath string) (int64, bool, error) {
	var id int64
	err := tx.QueryRowContext(ctx, `
		SELECT item.id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND item.kind = 'audio'
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
			AND location.path = ?
		ORDER BY location.id
		LIMIT 1
	`, target.WorkID, target.FileSourceID, libraryPath).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return id, err == nil, err
}

func workFolderEditAssignmentOrigin(item workFolderEditItem) string {
	if item.SourceKind == "remote" {
		return "remote_fetch"
	}
	return "library_import"
}
