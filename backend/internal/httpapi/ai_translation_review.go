package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

// Every account that may translate a category reviews its items, whoever
// requested them. Acceptance rechecks the acceptor's permissions, the source,
// the provider configuration and the content policy; a review does not expire
// otherwise. Two accounts accepting the same item settle it once.

type translationItemResponse struct {
	ID          int64  `json:"id"`
	RunID       int64  `json:"runId"`
	WorkID      int64  `json:"workId"`
	WorkCode    string `json:"workCode"`
	WorkTitle   string `json:"workTitle"`
	Language    string `json:"language"`
	Category    string `json:"category"`
	Subject     string `json:"subject"`
	State       string `json:"state"`
	FailureCode string `json:"failureCode,omitempty"`
	// Label names the object: a tag's source name, a file or folder path, or
	// a track's title.
	Label string `json:"label"`
	// Source and Result hold short text; lyrics are read as files.
	Source          string `json:"source"`
	Result          string `json:"result"`
	Model           string `json:"model"`
	SourceTitle     string `json:"sourceTitle,omitempty"`
	AppliedPath     string `json:"appliedPath,omitempty"`
	Progress        int    `json:"progress"`
	Chunks          int    `json:"chunks"`
	AffectedWorks   int    `json:"affectedWorks,omitempty"`
	RequestedBy     string `json:"requestedBy"`
	DurationSeconds int64  `json:"durationSeconds,omitempty"`
	UpdatedAt       string `json:"updatedAt"`
}

var translationListStates = map[string][]string{
	"review":    {"ready"},
	"active":    {"queued", "requesting"},
	"attention": {"failed", "uncertain", "invalid", "policy_blocked"},
	"history":   {"accepted"},
}

// listTranslationItems lists translation items by view: review (waiting for
// review), active, attention (stopped) or history, across works or for one.
func (s *Server) listTranslationItems(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Translation is unavailable in Demo.", false)
		return
	}
	actor, ok := userFromContext(r.Context())
	if !ok || !canUseTranslationCenter(actor) {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return
	}
	view := r.URL.Query().Get("view")
	if view == "" {
		view = "review"
	}
	states, ok := translationListStates[view]
	if !ok {
		writeAPIError(w, 400, "invalid_filter", "Invalid translation view.", false)
		return
	}
	where := "item.state IN (" + strings.TrimSuffix(strings.Repeat("?,", len(states)), ",") + ")"
	args := stringsToAny(states)
	if raw := r.URL.Query().Get("workId"); raw != "" {
		workID, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || workID <= 0 {
			writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
			return
		}
		family, err := s.lyricsAssignmentFamily(r.Context(), workID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeError(w, err)
			return
		}
		ids := []any{workID}
		for id := range family {
			if id != workID {
				ids = append(ids, id)
			}
		}
		mediaWorkID, err := s.resolveMediaWorkIDForRequest(r.Context(), workID)
		if err == nil {
			ids = append(ids, mediaWorkID)
		}
		where += " AND item.work_id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",") + ")"
		args = append(args, ids...)
	}
	if raw := r.URL.Query().Get("runId"); raw != "" {
		runID, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || runID <= 0 {
			writeAPIError(w, 400, "invalid_run_id", "Invalid run id.", false)
			return
		}
		where += " AND item.workflow_run_id = ?"
		args = append(args, runID)
	}
	order := "item.work_id, item.language, item.category, item.id"
	if view == "history" {
		order = "item.updated_at DESC, item.id DESC"
	}
	items, err := s.translationItemResponses(r.Context(), where+" ORDER BY "+order+" LIMIT 1000", args...)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": items})
}

func (s *Server) translationItemResponses(ctx context.Context, where string, args ...any) ([]translationItemResponse, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT "+translationItemColumns+`, work.primary_code, work.title, COALESCE(account.username, ''), item.updated_at,
		COALESCE((SELECT media.title FROM media_item AS media WHERE item.category IN ('lyrics', 'file_name') AND media.id = CAST(item.subject AS INTEGER)), ''),
		COALESCE((SELECT media.duration_seconds FROM media_item AS media WHERE item.category = 'lyrics' AND media.id = CAST(item.subject AS INTEGER)), 0),
		CASE WHEN item.category = 'tag' THEN (SELECT COUNT(DISTINCT link.work_id) FROM work_tag AS link WHERE link.tag_id = CAST(item.subject AS INTEGER)) ELSE 0 END
		FROM translation_item AS item
		INNER JOIN work ON work.id = item.work_id
		LEFT JOIN user_account AS account ON account.id = item.requested_by_user_id
		WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []translationItemResponse{}
	for rows.Next() {
		var item translationItem
		var detail, checkpoint string
		var response translationItemResponse
		var mediaTitle string
		if err := rows.Scan(&item.ID, &item.RunID, &item.WorkID, &item.UserID, &item.Language, &item.Category, &item.Subject,
			&item.State, &item.FailureCode, &detail, &item.SourceText, &item.SourceHash,
			&item.ResultText, &checkpoint, &item.RequestIndex, &item.ProviderID, &item.Model, &item.ConfigHash, &item.PolicyHash,
			&response.WorkCode, &response.WorkTitle, &response.RequestedBy, &response.UpdatedAt, &mediaTitle, &response.DurationSeconds,
			&response.AffectedWorks); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(detail), &item.Detail); err != nil {
			return nil, err
		}
		response.ID, response.RunID, response.WorkID = item.ID, item.RunID, item.WorkID
		response.Language, response.Category, response.Subject = item.Language, item.Category, item.Subject
		response.State, response.FailureCode, response.Model = item.State, item.FailureCode, item.Model
		// A persisted failure of an unknown request uses the same explicit
		// confirmation as an uncertain item.
		if item.State == "failed" && translationResultUnknown(item.FailureCode) {
			response.State = "uncertain"
		}
		response.SourceTitle, response.AppliedPath = item.Detail.SourceTitle, item.Detail.AppliedPath
		response.Progress, response.Chunks = item.RequestIndex, item.Detail.Chunks
		switch item.Category {
		case translationLyrics:
			response.Label = mediaTitle
		case translationFileName, translationFolderName:
			response.Label = item.Detail.Path
			response.Source, response.Result = item.SourceText, item.ResultText
		case translationTag:
			response.Label = item.SourceText
			response.Source, response.Result = item.SourceText, item.ResultText
		default:
			response.Source, response.Result = item.SourceText, item.ResultText
		}
		result = append(result, response)
	}
	return result, rows.Err()
}

// translationItemText returns the source or result of an item as text, so a
// reviewer reads lyrics with their timing.
func (s *Server) translationItemText(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Translation is unavailable in Demo.", false)
		return
	}
	actor, ok := userFromContext(r.Context())
	if !ok || !canUseTranslationCenter(actor) {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_translation_item", "Invalid translation item.", false)
		return
	}
	column := "result_text"
	if r.URL.Query().Get("side") == "source" {
		column = "source_text"
	}
	var text string
	if err := s.db.QueryRowContext(r.Context(), "SELECT "+column+" FROM translation_item WHERE id = ?", id).Scan(&text); err != nil {
		writeAPIError(w, 404, "translation_item_not_found", "Translation item not found.", false)
		return
	}
	setUntrustedFileHeaders(w)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, text)
}

type translationReviewRequest struct {
	IDs []int64 `json:"ids"`
	// AcknowledgeUncertain confirms that resending an uncertain request may
	// be charged again.
	AcknowledgeUncertain bool `json:"acknowledgeUncertain"`
}

type translationReviewResult struct {
	ID   int64  `json:"id"`
	OK   bool   `json:"ok"`
	Code string `json:"code,omitempty"`
}

func (s *Server) decodeTranslationReview(w http.ResponseWriter, r *http.Request) (currentUser, translationReviewRequest, bool) {
	var body translationReviewRequest
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Translation is unavailable in Demo.", false)
		return currentUser{}, body, false
	}
	actor, ok := userFromContext(r.Context())
	if !ok || !canUseTranslationCenter(actor) {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return currentUser{}, body, false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || len(body.IDs) == 0 || len(body.IDs) > 1000 {
		writeAPIError(w, 400, "invalid_translation_item", "Choose 1–1000 translation items.", false)
		return currentUser{}, body, false
	}
	return actor, body, true
}

func (s *Server) acceptTranslationItems(w http.ResponseWriter, r *http.Request) {
	actor, body, ok := s.decodeTranslationReview(w, r)
	if !ok {
		return
	}
	s.translationReviewMu.Lock()
	defer s.translationReviewMu.Unlock()
	results := make([]translationReviewResult, 0, len(body.IDs))
	for _, id := range body.IDs {
		code, err := s.acceptTranslationItem(r.Context(), actor, id)
		if err != nil {
			if r.Context().Err() != nil {
				writeError(w, err)
				return
			}
			slog.Warn("translation acceptance failed", "item", id, "error", err)
			code = "accept_failed"
		}
		results = append(results, translationReviewResult{ID: id, OK: code == "", Code: code})
	}
	writeJSON(w, 200, map[string]any{"results": results})
}

// acceptTranslationItem accepts one ready item and returns the code that
// refused it, or empty.
func (s *Server) acceptTranslationItem(ctx context.Context, actor currentUser, id int64) (string, error) {
	items, err := loadTranslationItems(ctx, s.db, "item.id = ?", id)
	if err != nil {
		return "", err
	}
	if len(items) == 0 {
		return "not_found", nil
	}
	item := items[0]
	switch item.State {
	case "ready":
	case "accepted", "rejected":
		return "already_handled", nil
	default:
		return "not_ready", nil
	}
	if !hasTranslationPermissions(actor, item.Category) {
		return "permission_denied", nil
	}
	provider, err := s.llmProvider(ctx, item.ProviderID)
	if err != nil || !provider.Enabled || s.llmConfigHash(provider, item.Model) != item.ConfigHash {
		return s.invalidateTranslationItem(ctx, item, "provider_changed")
	}
	policy, err := s.llmStore.Policy(ctx)
	if err != nil || llmValueHash(policy) != item.PolicyHash {
		return s.invalidateTranslationItem(ctx, item, "policy_changed")
	}
	input, err := loadLLMWorkInput(ctx, s.db, item.WorkID)
	if err != nil {
		return s.invalidateTranslationItem(ctx, item, "source_changed")
	}
	source := llm.Text{}
	switch item.Category {
	case translationTitle:
		source.Title = item.SourceText
	case translationDescription:
		source.Description = item.SourceText
	case translationLyrics:
		if document, err := llm.ParseLyrics("source"+item.Detail.Extension, item.SourceText); err == nil {
			source.Lyrics = document.Text()
		}
	default:
		source.Tags = []string{item.SourceText}
	}
	if !llmAllowed(assessLLMTranslation(policy, input, source).Class, provider) {
		return s.invalidateTranslationItem(ctx, item, "policy_blocked")
	}
	switch item.Category {
	case translationTitle, translationDescription, translationTag:
		return s.acceptMetadataTranslation(ctx, actor, item)
	case translationFileName, translationFolderName:
		return s.acceptNameTranslation(ctx, actor, item)
	}
	return s.acceptLyricsTranslation(ctx, actor, item)
}

func (s *Server) invalidateTranslationItem(ctx context.Context, item translationItem, code string) (string, error) {
	_, err := s.db.ExecContext(ctx, "UPDATE translation_item SET state = 'invalid', failure_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state = 'ready'", code, item.ID)
	return code, err
}

// settleAcceptedItem marks an item accepted inside the transaction that
// applies it; it settles once even when two reviewers accept together.
func settleAcceptedItem(ctx context.Context, tx *sql.Tx, item translationItem, userID int64) (bool, error) {
	result, err := tx.ExecContext(ctx, `UPDATE translation_item SET state = 'accepted', reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND state = 'ready'`, nullableUserID(userID), item.ID)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	return count == 1, err
}

func (s *Server) acceptMetadataTranslation(ctx context.Context, actor currentUser, item translationItem) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	input, err := loadLLMWorkInput(ctx, tx, item.WorkID)
	if err != nil {
		return "", err
	}
	var current string
	if item.Category == translationTag {
		current, err = currentTagSourceName(ctx, tx, item.Subject)
	} else {
		current, err = s.currentTranslationSource(ctx, item, input)
	}
	if err != nil {
		return "", err
	}
	if current != item.SourceText {
		_ = tx.Rollback()
		return s.invalidateTranslationItem(ctx, item, "source_changed")
	}
	settled, err := settleAcceptedItem(ctx, tx, item, actor.ID)
	if err != nil || !settled {
		return "already_handled", err
	}
	if item.Category == translationTag {
		tagID, _ := strconv.ParseInt(item.Subject, 10, 64)
		if _, err := tx.ExecContext(ctx, `INSERT INTO metadata_tag_llm_name(tag_id,language,name,source_text,provider_id,model,created_by_user_id) VALUES(?,?,?,?,?,?,?)
			ON CONFLICT(tag_id,language) DO UPDATE SET name=excluded.name,source_text=excluded.source_text,provider_id=excluded.provider_id,model=excluded.model,created_by_user_id=excluded.created_by_user_id,updated_at=CURRENT_TIMESTAMP`,
			tagID, item.Language, item.ResultText, item.SourceText, item.ProviderID, item.Model, actor.ID); err != nil {
			return "", err
		}
		if err := metadatatags.RefreshNamesTx(ctx, tx, metadatatags.StoredLanguages, tagID); err != nil {
			return "", err
		}
		return "", tx.Commit()
	}
	if err := archiveLLMTranslation(ctx, tx, item.WorkID, item.Language, item.Category, actor.ID, "superseded"); err != nil {
		return "", err
	}
	metadataInput := input
	metadataInput.LyricsHash = ""
	if _, err := tx.ExecContext(ctx, `INSERT INTO work_llm_translation(work_id,language,field_name,value_text,source_hash,provider_id,model,created_by_user_id,source_text,source_work_id)
		VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id,language,field_name) DO UPDATE SET value_text=excluded.value_text,source_hash=excluded.source_hash,provider_id=excluded.provider_id,model=excluded.model,status='accepted',created_by_user_id=excluded.created_by_user_id,source_text=excluded.source_text,source_work_id=excluded.source_work_id,updated_at=CURRENT_TIMESTAMP`,
		item.WorkID, item.Language, item.Category, item.ResultText, llmInputHash(metadataInput), item.ProviderID, item.Model, actor.ID, item.SourceText, input.SourceID); err != nil {
		return "", err
	}
	if err := archiveLLMTranslation(ctx, tx, item.WorkID, item.Language, item.Category, actor.ID, "accepted"); err != nil {
		return "", err
	}
	return "", tx.Commit()
}

func (s *Server) acceptNameTranslation(ctx context.Context, actor currentUser, item translationItem) (string, error) {
	files, folders, err := s.localDisplayNameEntries(ctx, item.Detail.MediaWorkID)
	if err != nil {
		return "", err
	}
	present := false
	for _, file := range files {
		present = present || item.Category == translationFileName && strconv.FormatInt(file.MediaItemID, 10) == item.Subject && file.Path == item.Detail.Path
	}
	for _, folder := range folders {
		present = present || item.Category == translationFolderName && folder == item.Subject
	}
	if !present || displayNameSource(item.Detail.Path, item.Category == translationFileName) != item.SourceText {
		return s.invalidateTranslationItem(ctx, item, "source_changed")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	settled, err := settleAcceptedItem(ctx, tx, item, actor.ID)
	if err != nil || !settled {
		return "already_handled", err
	}
	// A name someone gave the file or folder meanwhile is kept.
	if item.Category == translationFileName {
		_, err = tx.ExecContext(ctx, `INSERT INTO media_item_display_name (media_item_id, language, name, updated_by_user_id, origin, model, source_text)
			VALUES (?, ?, ?, ?, 'llm', ?, ?) ON CONFLICT(media_item_id, language) DO NOTHING`,
			item.Subject, item.Language, item.ResultText, nullableUserID(actor.ID), item.Model, item.SourceText)
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO work_folder_display_name (work_id, path, language, name, updated_by_user_id, origin, model, source_text)
			VALUES (?, ?, ?, ?, ?, 'llm', ?, ?) ON CONFLICT(work_id, path, language) DO NOTHING`,
			item.Detail.MediaWorkID, item.Subject, item.Language, item.ResultText, nullableUserID(actor.ID), item.Model, item.SourceText)
	}
	if err != nil {
		return "", err
	}
	return "", tx.Commit()
}

// acceptLyricsTranslation publishes lyrics into the track's work folder while
// the lyrics file they were translated from is unchanged.
func (s *Server) acceptLyricsTranslation(ctx context.Context, actor currentUser, item translationItem) (string, error) {
	audioID, _ := strconv.ParseInt(item.Subject, 10, 64)
	track, err := s.loadLocalTrack(ctx, audioID)
	if errors.Is(err, errLocalTrackUnavailable) || err == nil && track.FolderID != item.Detail.FolderID {
		return s.invalidateTranslationItem(ctx, item, "source_changed")
	}
	if err != nil {
		return "", err
	}
	send := &translationSend{actor: actor}
	if send.policy, err = s.llmStore.Policy(ctx); err != nil {
		return "", err
	}
	if _, hash, code := s.translationLyricsSource(ctx, send, item); code != "" || hash != item.SourceHash {
		return s.invalidateTranslationItem(ctx, item, "source_changed")
	}
	lyricsPath, lyricsID, err := s.publishTrackLyrics(ctx, actor.ID, track.WorkID, audioID, track.FolderID, item.Language, track.Path, item.Detail.Extension, item.ResultText, "translation")
	if err != nil {
		var requestErr lyricsFetchRequestError
		if errors.Is(err, errLyricsFolderBlocked) || errors.As(err, &requestErr) {
			return "lyrics_folder_blocked", nil
		}
		return "", err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	settled, err := settleAcceptedItem(ctx, tx, item, actor.ID)
	if err != nil || !settled {
		return "already_handled", err
	}
	// The history names the file the lyrics became.
	if _, err := tx.ExecContext(ctx, "UPDATE translation_item SET detail_json = json_set(detail_json, '$.appliedPath', ?) WHERE id = ?", lyricsPath, item.ID); err != nil {
		return "", err
	}
	if lyricsID > 0 {
		if _, err := tx.ExecContext(ctx, `INSERT INTO media_lyrics_ai_source(lyrics_media_item_id, asr_model, llm_model) VALUES(?, '', ?)
			ON CONFLICT(lyrics_media_item_id) DO UPDATE SET asr_model = excluded.asr_model, llm_model = excluded.llm_model`, lyricsID, item.Model); err != nil {
			return "", err
		}
	}
	return "", tx.Commit()
}

func (s *Server) rejectTranslationItems(w http.ResponseWriter, r *http.Request) {
	actor, body, ok := s.decodeTranslationReview(w, r)
	if !ok {
		return
	}
	s.translationReviewMu.Lock()
	defer s.translationReviewMu.Unlock()
	results := make([]translationReviewResult, 0, len(body.IDs))
	for _, id := range body.IDs {
		code, err := s.rejectTranslationItem(r.Context(), actor, id)
		if err != nil {
			writeError(w, err)
			return
		}
		results = append(results, translationReviewResult{ID: id, OK: code == "", Code: code})
	}
	writeJSON(w, 200, map[string]any{"results": results})
}

// rejectTranslationItem discards an item that waits for review or stopped.
func (s *Server) rejectTranslationItem(ctx context.Context, actor currentUser, id int64) (string, error) {
	items, err := loadTranslationItems(ctx, s.db, "item.id = ?", id)
	if err != nil || len(items) == 0 {
		return "not_found", err
	}
	item := items[0]
	if !hasTranslationPermissions(actor, item.Category) {
		return "permission_denied", nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `UPDATE translation_item SET state = 'rejected', reviewed_by_user_id = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND state IN ('ready', 'failed', 'uncertain', 'invalid', 'policy_blocked')`, nullableUserID(actor.ID), item.ID)
	if err != nil {
		return "", err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return "already_handled", err
	}
	return "", tx.Commit()
}

// resendTranslationItems queues stopped items of a run again. A request whose
// result is unknown is resent only after explicit acknowledgement, because it
// may be charged twice. An item whose result acceptance could not apply is
// accepted again without another request, and one whose source, provider or
// policy changed needs a new request.
func (s *Server) resendTranslationItems(w http.ResponseWriter, r *http.Request) {
	actor, body, ok := s.decodeTranslationReview(w, r)
	if !ok {
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	results := make([]translationReviewResult, 0, len(body.IDs))
	runs := map[int64]bool{}
	reaccept := []int64{}
	for _, id := range body.IDs {
		items, err := loadTranslationItems(r.Context(), tx, "item.id = ?", id)
		if err != nil {
			writeError(w, err)
			return
		}
		code := ""
		switch {
		case len(items) == 0:
			code = "not_found"
		case !hasTranslationPermissions(actor, items[0].Category):
			code = "permission_denied"
		case items[0].State != "failed" && items[0].State != "uncertain":
			code = "not_resendable"
		case translationNeedsNewRequest[items[0].FailureCode]:
			code = "not_resendable"
		}
		if code == "" {
			code, err = requeueTranslationItemTx(r.Context(), tx, items[0], body.AcknowledgeUncertain)
			if err != nil {
				writeError(w, err)
				return
			}
		}
		if code == "" {
			if items[0].ResultText != "" && translationApplyFailures[items[0].FailureCode] {
				reaccept = append(reaccept, id)
			} else {
				runs[items[0].RunID] = true
			}
		}
		results = append(results, translationReviewResult{ID: id, OK: code == "", Code: code})
	}
	for runID := range runs {
		if err := requeueAITranslationJobTx(r.Context(), tx, runID); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	for _, id := range reaccept {
		if err := s.autoAcceptTranslationItem(r.Context(), id, &actor); err != nil {
			writeError(w, err)
			return
		}
	}
	writeJSON(w, 200, map[string]any{"results": results})
}

// translationApplyFailures are the codes of a result that acceptance could
// not apply; sending the item again accepts the kept result.
var translationApplyFailures = map[string]bool{"permission_changed": true, "lyrics_folder_blocked": true, "accept_failed": true}

func translationResultUnknown(code string) bool {
	return code == "upstream_result_unknown" || code == "cancelled_result_unknown"
}

// translationNeedsNewRequest are the codes of an item whose source, provider
// or policy changed; only a new request translates it again.
var translationNeedsNewRequest = map[string]bool{"source_changed": true, "provider_changed": true, "policy_changed": true, "policy_blocked": true}

// requeueTranslationItemTx queues one stopped item again.
func requeueTranslationItemTx(ctx context.Context, tx *sql.Tx, item translationItem, acknowledgeUncertain bool) (string, error) {
	if translationNeedsNewRequest[item.FailureCode] {
		return "not_resendable", nil
	}
	if !acknowledgeUncertain && (item.State == "uncertain" || translationResultUnknown(item.FailureCode)) {
		return "llm_acknowledgement_required", nil
	}
	var active bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM translation_item WHERE dedup_key = ? AND id <> ?
		AND state IN ('queued', 'requesting', 'ready', 'uncertain'))`,
		translationDedupKey(item.Language, item.Category, item.WorkID, item.Subject), item.ID).Scan(&active); err != nil {
		return "", err
	}
	if active {
		return "already_active", nil
	}
	state := "queued"
	if item.ResultText != "" && translationApplyFailures[item.FailureCode] {
		state = "ready"
	}
	result, err := tx.ExecContext(ctx, `UPDATE OR IGNORE translation_item SET state = ?, failure_code = '', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND state IN ('failed', 'uncertain')`, state, item.ID)
	if err != nil {
		return "", err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return "already_active", err
	}
	return "", nil
}

// requeueAITranslationJobTx queues a run's job again after its items were
// queued, whatever the job ended with.
func requeueAITranslationJobTx(ctx context.Context, tx *sql.Tx, runID int64) error {
	result, err := tx.ExecContext(ctx, `UPDATE workflow_job SET status = 'queued', available_at = NULL, error_message = '', locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ? AND worker_type = ? AND status IN ('succeeded', 'failed', 'cancelled')`, runID, aiTranslationWorkerType)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count == 0 {
		// A job that is queued or running picks the items up itself.
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'queued', error_message = '', finished_at = NULL WHERE workflow_run_id = ?", runID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE workflow_run SET status = 'queued', finished_at = NULL,
		summary_json = json_set(COALESCE(NULLIF(summary_json, ''), '{}'), '$.retry_reason', 'Translation items resent') WHERE id = ?`, runID)
	return err
}

// retryAITranslationRun queues the run's failed items again, the retry
// Activity offers. Items whose result is unknown wait for an explicit resend
// on the Translation page, and invalidated items for a new request.
func (s *Server) retryAITranslationRun(ctx context.Context, actor currentUser, runID int64) (workflowRetryDispatchResult, error) {
	if !canUseTranslationCenter(actor) {
		return workflowRetryDispatchResult{}, errWorkflowRetryPermission
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workflowRetryDispatchResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	items, err := loadTranslationItems(ctx, tx, "item.workflow_run_id = ? AND item.state = 'failed' ORDER BY item.id", runID)
	if err != nil {
		return workflowRetryDispatchResult{}, err
	}
	queued := 0
	reaccept := []int64{}
	for _, item := range items {
		if !hasTranslationPermissions(actor, item.Category) {
			continue
		}
		code, err := requeueTranslationItemTx(ctx, tx, item, false)
		if err != nil {
			return workflowRetryDispatchResult{}, err
		}
		if code == "" {
			queued++
			if item.ResultText != "" && translationApplyFailures[item.FailureCode] {
				reaccept = append(reaccept, item.ID)
			}
		}
	}
	if queued == 0 {
		return workflowRetryDispatchResult{}, errWorkflowRetryNoRecoverableJob
	}
	if err := requeueAITranslationJobTx(ctx, tx, runID); err != nil {
		return workflowRetryDispatchResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return workflowRetryDispatchResult{}, err
	}
	for _, id := range reaccept {
		if err := s.autoAcceptTranslationItem(ctx, id, &actor); err != nil {
			return workflowRetryDispatchResult{}, err
		}
	}
	return workflowRetryDispatchResult{NewRunID: runID, ResumedExistingRun: true}, nil
}
