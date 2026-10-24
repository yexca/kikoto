package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type aiTranslationJobPayload struct {
	UserID int64 `json:"requested_by_user_id"`
}

// errAITranslationYield stops a job at a safe point so other queued work can
// use the executor; the job continues from its items when it runs again.
var errAITranslationYield = errors.New("translation yields to other queued work")

func (s *Server) executeAITranslationJob(ctx context.Context, job workflowJobRecord) error {
	return s.executeAITranslationWithDecoder(ctx, job, extractASRChunk)
}

// executeAITranslationWithDecoder runs a Translate with AI run: it first
// transcribes the tracks that need it, then translates the queued items of
// each language. Speech recognition and translation run one request at a
// time, so a local service that offers both never loads both models at once.
// Every outcome is recorded on its item; one item's failure leaves the others
// running.
func (s *Server) executeAITranslationWithDecoder(ctx context.Context, job workflowJobRecord, decode asrDecoder) error {
	var payload aiTranslationJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		return errors.New("invalid translation job")
	}
	// A request in flight when the process stopped may have been answered and
	// charged; only an explicit resend repeats it.
	if _, err := s.db.ExecContext(ctx, `UPDATE translation_item SET state = 'uncertain', failure_code = 'upstream_result_unknown', updated_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ? AND state = 'requesting'`, job.RunID); err != nil {
		return err
	}
	transcriptions, err := s.runTranscriptionIDs(ctx, job.RunID)
	if err != nil {
		return err
	}
	for index, id := range transcriptions {
		task, err := s.loadASRTask(ctx, id)
		if err != nil {
			return err
		}
		if task.RunID != job.RunID {
			return errors.New("translation job scope mismatch")
		}
		code, err := s.transcribeTrack(ctx, job, &task, decode)
		if err != nil {
			return err
		}
		if code == asrYield {
			return s.deferWorkflowJob(ctx, job, asrYieldDelay, "Transcription yields to other queued work between chunks")
		}
		if code != "" {
			err = s.transcriptionFailed(ctx, task.ID, code)
		} else {
			err = s.transcriptionReady(ctx, task.ID)
		}
		if err != nil {
			return err
		}
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "transcribing", map[string]any{"run_id": job.RunID}, index+1, len(transcriptions)); err != nil {
			return err
		}
	}
	languages, err := s.queuedTranslationLanguages(ctx, job.RunID)
	if err != nil {
		return err
	}
	for _, language := range languages {
		if err := s.translateQueuedItems(ctx, job, language); err != nil {
			if errors.Is(err, errAITranslationYield) {
				return s.deferWorkflowJob(ctx, job, asrYieldDelay, "Translation yields to other queued work between requests")
			}
			return err
		}
	}
	return s.finishAITranslationJob(ctx, job)
}

func (s *Server) runTranscriptionIDs(ctx context.Context, runID int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM asr_transcription WHERE workflow_run_id = ? AND state IN ('pending', 'requesting')
		ORDER BY created_at, rowid`, runID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Server) queuedTranslationLanguages(ctx context.Context, runID int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT language FROM translation_item WHERE workflow_run_id = ? AND state = 'queued' AND engine = 'llm'
		GROUP BY language ORDER BY MIN(id)`, runID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	languages := []string{}
	for rows.Next() {
		var language string
		if err := rows.Scan(&language); err != nil {
			return nil, err
		}
		languages = append(languages, language)
	}
	return languages, rows.Err()
}

// transcriptionReady offers a finished transcript for review, accepting it
// when auto-accept is on, and releases the translations waiting for it. The transcript is their source; they never
// read another translation.
func (s *Server) transcriptionReady(ctx context.Context, id string) error {
	var text, model string
	if err := s.db.QueryRowContext(ctx, "SELECT value_text, model FROM asr_transcription WHERE id = ?", id).Scan(&text, &model); err != nil {
		return err
	}
	attribute, err := s.lyricsAttributionEnabled(ctx)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	items, err := loadTranslationItems(ctx, tx, "item.asr_transcription_id = ? AND item.state IN ('queued', 'waiting_transcription')", id)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.Engine == "asr" {
			result := text
			if attribute {
				if result, err = llm.AddAttribution(".vtt", text, llm.Attribution(item.Language, model, "")); err != nil {
					result = text
				}
			}
			_, err = tx.ExecContext(ctx, "UPDATE translation_item SET state = 'ready', result_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", result, item.ID)
		} else {
			_, err = tx.ExecContext(ctx, "UPDATE translation_item SET state = 'queued', source_text = ?, source_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", text, llmValueHash(text), item.ID)
		}
		if err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, item := range items {
		if item.Engine == "asr" {
			if err := s.autoAcceptTranslationItem(ctx, item.ID, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

// transcriptionFailed stops the transcription's items; the run's other items
// continue.
func (s *Server) transcriptionFailed(ctx context.Context, id, code string) error {
	_, err := s.db.ExecContext(context.WithoutCancel(ctx), `UPDATE translation_item
		SET state = 'failed', failure_code = CASE WHEN engine = 'asr' THEN ? ELSE 'transcription_failed' END, updated_at = CURRENT_TIMESTAMP
		WHERE asr_transcription_id = ? AND state IN ('queued', 'waiting_transcription')`, code, id)
	return err
}

// translationSend is what every request of a language checks before it
// leaves: the requester, the provider configuration and the policy the items
// were planned with.
type translationSend struct {
	actor    currentUser
	provider llm.Provider
	policy   llm.Policy
	client   llm.Client
	closer   func()
}

func (send *translationSend) close() {
	if send.closer != nil {
		send.closer()
	}
}

// translateQueuedItems translates the queued items of one language: the
// work's title, description and tag names in one request, display names in
// batches, then each track's lyrics in chunks.
func (s *Server) translateQueuedItems(ctx context.Context, job workflowJobRecord, language string) error {
	items, err := loadTranslationItems(ctx, s.db, "item.workflow_run_id = ? AND item.language = ? AND item.state = 'queued' AND item.engine = 'llm' ORDER BY item.id", job.RunID, language)
	if err != nil || len(items) == 0 {
		return err
	}
	send := &translationSend{}
	defer send.close()
	if code := s.prepareTranslationSend(ctx, items[0], send); code != "" {
		return s.stopTranslationItems(ctx, items, code)
	}
	metadata, names, lyrics := []translationItem{}, []translationItem{}, []translationItem{}
	for _, item := range items {
		switch item.Category {
		case translationTitle, translationDescription, translationTag:
			metadata = append(metadata, item)
		case translationFileName, translationFolderName:
			names = append(names, item)
		default:
			lyrics = append(lyrics, item)
		}
	}
	if len(metadata) > 0 {
		if err := s.translateMetadataItems(ctx, job, send, metadata); err != nil {
			return err
		}
	}
	for _, batch := range nameBatches(translationSourceTexts(names)) {
		if s.asrShouldYield(ctx, job.ID) {
			return errAITranslationYield
		}
		if err := s.translateNameItems(ctx, job, send, names[batch[0]:batch[1]]); err != nil {
			return err
		}
	}
	for _, item := range lyrics {
		if s.asrShouldYield(ctx, job.ID) {
			return errAITranslationYield
		}
		if err := s.translateLyricsItem(ctx, job, send, item); err != nil {
			return err
		}
	}
	return nil
}

func translationSourceTexts(items []translationItem) []string {
	texts := make([]string, len(items))
	for index, item := range items {
		texts[index] = item.SourceText
	}
	return texts
}

// prepareTranslationSend loads the requester, provider and policy and
// returns the code that stops the items when any changed since planning.
func (s *Server) prepareTranslationSend(ctx context.Context, item translationItem, send *translationSend) string {
	actor, err := s.accountStore.LoadByID(ctx, item.UserID)
	if err != nil || item.UserID == 0 {
		return "permission_changed"
	}
	send.actor = actor
	provider, err := s.llmProvider(ctx, item.ProviderID)
	if err != nil || !provider.Enabled || s.llmConfigHash(provider, item.Model) != item.ConfigHash {
		return "provider_changed"
	}
	policy, err := s.llmStore.Policy(ctx)
	if err != nil || llmValueHash(policy) != item.PolicyHash {
		return "policy_changed"
	}
	send.provider, send.policy = provider, policy
	client, closer, err := s.llmClient(ctx, provider, provider.RequestTimeout())
	if err != nil {
		return "endpoint_unavailable"
	}
	send.client, send.closer = client, closer
	return ""
}

// recheckTranslationSend repeats the planning checks immediately before a
// request.
func (s *Server) recheckTranslationSend(ctx context.Context, item translationItem, send *translationSend) string {
	actor, err := s.accountStore.LoadByID(ctx, item.UserID)
	if err != nil || !hasTranslationPermissions(actor, item.Category) {
		return "permission_changed"
	}
	provider, err := s.llmProvider(ctx, item.ProviderID)
	if err != nil || !provider.Enabled || s.llmConfigHash(provider, item.Model) != item.ConfigHash {
		return "provider_changed"
	}
	policy, err := s.llmStore.Policy(ctx)
	if err != nil || llmValueHash(policy) != item.PolicyHash {
		return "policy_changed"
	}
	send.actor = actor
	return ""
}

// stopTranslationItems ends items before any request with a fixed code. A
// changed boundary invalidates them; a blocked or unreachable service fails
// them.
func (s *Server) stopTranslationItems(ctx context.Context, items []translationItem, code string) error {
	state := "invalid"
	switch code {
	case "policy_blocked":
		state = "policy_blocked"
	case "endpoint_unavailable", "transcription_unavailable", "source_temporarily_unavailable":
		state = "failed"
	}
	for _, item := range items {
		if _, err := s.db.ExecContext(context.WithoutCancel(ctx), `UPDATE translation_item SET state = ?, failure_code = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND state IN ('queued', 'requesting')`, state, code, item.ID); err != nil {
			return err
		}
	}
	return nil
}

// markTranslationRequesting records that a request for the items is about to
// leave. It commits together with the run's cancellation check.
func (s *Server) markTranslationRequesting(ctx context.Context, runID int64, items []translationItem) error {
	ids := make([]any, 0, len(items)+1)
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	ids = append(ids, runID)
	result, err := s.db.ExecContext(ctx, `UPDATE translation_item SET state = 'requesting', updated_at = CURRENT_TIMESTAMP
		WHERE id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(items)), ",")+`) AND state = 'queued'
			AND NOT EXISTS (SELECT 1 FROM workflow_run WHERE id = ? AND status = 'cancelled')`, ids...)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != int64(len(items)) {
		return errors.New("translation items cannot send a request")
	}
	return nil
}

// translationRequestFailure names what a failed request leaves its items
// with. A definitive rejection fails them and may be retried; any other error
// leaves the result unknown, and only an explicit resend repeats it.
func translationRequestFailure(err error) (string, string) {
	if code := llmHelperRejection(err); code != "" {
		return "failed", code
	}
	var rejected llm.UpstreamError
	if errors.As(err, &rejected) && (rejected.Status == 400 || rejected.Status == 401 || rejected.Status == 403 || rejected.Status == 404 || rejected.Status == 422 || rejected.Status == 429) {
		return "failed", "upstream_rejected"
	}
	return "uncertain", "upstream_result_unknown"
}

func (s *Server) failTranslationRequest(ctx context.Context, items []translationItem, requestErr error) error {
	state, code := translationRequestFailure(requestErr)
	for _, item := range items {
		if _, err := s.db.ExecContext(context.WithoutCancel(ctx), `UPDATE translation_item SET state = ?, failure_code = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND state = 'requesting'`, state, code, item.ID); err != nil {
			return err
		}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

func (s *Server) translateMetadataItems(ctx context.Context, job workflowJobRecord, send *translationSend, items []translationItem) error {
	input, err := loadLLMWorkInput(ctx, s.db, items[0].WorkID)
	if err != nil {
		return s.stopTranslationItems(ctx, items, "source_changed")
	}
	ready := []translationItem{}
	text := llm.Text{}
	for _, item := range items {
		if code := s.recheckTranslationSend(ctx, item, send); code != "" {
			if err := s.stopTranslationItems(ctx, []translationItem{item}, code); err != nil {
				return err
			}
			continue
		}
		current, err := s.currentTranslationSource(ctx, item, input)
		if err != nil {
			return err
		}
		if current != item.SourceText {
			if err := s.stopTranslationItems(ctx, []translationItem{item}, "source_changed"); err != nil {
				return err
			}
			continue
		}
		switch item.Category {
		case translationTitle:
			text.Title = item.SourceText
		case translationDescription:
			text.Description = item.SourceText
		default:
			text.Tags = append(text.Tags, item.SourceText)
		}
		ready = append(ready, item)
	}
	if len(ready) == 0 {
		return nil
	}
	if !llmAllowed(assessLLMTranslation(send.policy, input, text).Class, send.provider) {
		return s.stopTranslationItems(ctx, ready, "policy_blocked")
	}
	if err := s.markTranslationRequesting(ctx, job.RunID, ready); err != nil {
		return err
	}
	translated, requestErr := send.client.Translate(ctx, ready[0].Model, ready[0].Detail.SourceLanguage, ready[0].Language, text)
	if requestErr != nil {
		return s.failTranslationRequest(ctx, ready, requestErr)
	}
	tag := 0
	for _, item := range ready {
		value := translated.Title
		switch item.Category {
		case translationDescription:
			value = translated.Description
		case translationTag:
			value = translated.Tags[tag]
			tag++
		}
		if err := s.finishTranslationItem(ctx, item, value); err != nil {
			return err
		}
	}
	return nil
}

// currentTranslationSource is an item's source text as it is now.
func (s *Server) currentTranslationSource(ctx context.Context, item translationItem, input llmWorkInput) (string, error) {
	switch item.Category {
	case translationTitle:
		return input.Text.Title, nil
	case translationDescription:
		return input.Text.Description, nil
	case translationTag:
		return currentTagSourceName(ctx, s.db, item.Subject)
	}
	return "", nil
}

// currentTagSourceName is the name a shared tag is translated from, as
// loadLLMTagCandidates chooses it.
func currentTagSourceName(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, subject string) (string, error) {
	id, err := strconv.ParseInt(subject, 10, 64)
	if err != nil {
		return "", nil
	}
	var name string
	err = q.QueryRowContext(ctx, `SELECT COALESCE((SELECT name FROM metadata_tag_name WHERE tag_id=tag.id ORDER BY (language='ja-jp') DESC,language LIMIT 1),
		(SELECT name FROM dlsite_genre_name WHERE genre_id=concept.dlsite_genre_id ORDER BY (language='ja-jp') DESC,language LIMIT 1),
		(SELECT name FROM metadata_tag_provider_name WHERE tag_id=tag.id ORDER BY (language='ja-jp') DESC,language LIMIT 1),
		(SELECT source_text FROM metadata_tag_llm_name WHERE tag_id=tag.id ORDER BY language LIMIT 1),tag.display_name)
		FROM tag JOIN metadata_tag concept ON concept.tag_id = tag.id WHERE tag.id = ? AND concept.hidden = 0 AND concept.merged_into_tag_id IS NULL`, id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return name, err
}

// finishTranslationItem offers an item's result for review, accepting it
// when auto-accept is on.
func (s *Server) finishTranslationItem(ctx context.Context, item translationItem, result string) error {
	if _, err := s.db.ExecContext(context.WithoutCancel(ctx), `UPDATE translation_item SET state = 'ready', result_text = ?, failure_code = '', checkpoint_json = '{}', updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND state IN ('requesting', 'queued')`, result, item.ID); err != nil {
		return err
	}
	return s.autoAcceptTranslationItem(ctx, item.ID, nil)
}

func (s *Server) translateNameItems(ctx context.Context, job workflowJobRecord, send *translationSend, items []translationItem) error {
	files, folders, err := s.localDisplayNameEntries(ctx, items[0].Detail.MediaWorkID)
	if err != nil {
		return err
	}
	present := map[string]bool{}
	for _, file := range files {
		present[translationFileName+"|"+strconv.FormatInt(file.MediaItemID, 10)+"|"+file.Path] = true
	}
	for _, folder := range folders {
		present[translationFolderName+"|"+folder+"|"+folder] = true
	}
	input, err := loadLLMWorkInput(ctx, s.db, items[0].WorkID)
	if err != nil {
		return s.stopTranslationItems(ctx, items, "source_changed")
	}
	ready := []translationItem{}
	text := llm.Text{}
	for _, item := range items {
		if code := s.recheckTranslationSend(ctx, item, send); code != "" {
			if err := s.stopTranslationItems(ctx, []translationItem{item}, code); err != nil {
				return err
			}
			continue
		}
		if !present[item.Category+"|"+item.Subject+"|"+item.Detail.Path] {
			if err := s.stopTranslationItems(ctx, []translationItem{item}, "source_changed"); err != nil {
				return err
			}
			continue
		}
		text.Tags = append(text.Tags, item.SourceText)
		ready = append(ready, item)
	}
	if len(ready) == 0 {
		return nil
	}
	if !llmAllowed(assessLLMTranslation(send.policy, input, text).Class, send.provider) {
		return s.stopTranslationItems(ctx, ready, "policy_blocked")
	}
	if err := s.markTranslationRequesting(ctx, job.RunID, ready); err != nil {
		return err
	}
	translated, requestErr := send.client.Translate(ctx, ready[0].Model, ready[0].Detail.SourceLanguage, ready[0].Language, text)
	if requestErr != nil {
		return s.failTranslationRequest(ctx, ready, requestErr)
	}
	for index, item := range ready {
		name, err := normalizeFileDisplayName(translated.Tags[index])
		if err != nil || name == "" {
			if _, err := s.db.ExecContext(ctx, "UPDATE translation_item SET state = 'failed', failure_code = 'invalid_output', updated_at = CURRENT_TIMESTAMP WHERE id = ?", item.ID); err != nil {
				return err
			}
			continue
		}
		if err := s.finishTranslationItem(ctx, item, name); err != nil {
			return err
		}
	}
	return nil
}

// translationLyricsSource reads the lyrics a lyrics item translates: its
// transcription, or the chosen file.
func (s *Server) translationLyricsSource(ctx context.Context, send *translationSend, item translationItem) (llm.LyricsDocument, string, string) {
	audioID, _ := strconv.ParseInt(item.Subject, 10, 64)
	if item.TranscriptionID != "" {
		var text, state string
		if err := s.db.QueryRowContext(ctx, "SELECT value_text, state FROM asr_transcription WHERE id = ?", item.TranscriptionID).Scan(&text, &state); err != nil ||
			state != "ready" && state != "publishing" && state != "accepted" || text == "" {
			return llm.LyricsDocument{}, "", "transcription_unavailable"
		}
		document, err := llm.ParseLyrics("transcript.vtt", text)
		if err != nil {
			return document, "", "transcription_unavailable"
		}
		return document, llmValueHash(text), ""
	}
	lyrics, err := s.loadLLMLyrics(context.WithValue(ctx, currentUserKey, send.actor), item.WorkID,
		llmTranslatePayload{LyricsLocationID: item.Detail.SourceLocationID, AudioMediaItemID: audioID, FolderID: item.Detail.FolderID}, send.policy)
	if err != nil {
		var invalid llmRequestError
		if errors.As(err, &invalid) && invalid.Code == "llm_lyrics_unavailable" {
			return llm.LyricsDocument{}, "", "source_temporarily_unavailable"
		}
		return llm.LyricsDocument{}, "", "source_changed"
	}
	return lyrics.Document, lyrics.Hash, ""
}

func (s *Server) translateLyricsItem(ctx context.Context, job workflowJobRecord, send *translationSend, item translationItem) error {
	if code := s.recheckTranslationSend(ctx, item, send); code != "" {
		return s.stopTranslationItems(ctx, []translationItem{item}, code)
	}
	document, hash, code := s.translationLyricsSource(ctx, send, item)
	if code != "" {
		return s.stopTranslationItems(ctx, []translationItem{item}, code)
	}
	lines := document.Text()
	chunks := (len(lines) + llm.LyricsChunkLines - 1) / llm.LyricsChunkLines
	if item.RequestIndex == 0 && len(item.Checkpoint) == 0 {
		// The first read fixes the source the chunks translate.
		source, err := document.Render(lines)
		if err != nil {
			return s.stopTranslationItems(ctx, []translationItem{item}, "source_changed")
		}
		item.Detail.Chunks = chunks
		item.SourceText, item.SourceHash = source, hash
		if _, err := s.db.ExecContext(ctx, "UPDATE translation_item SET source_text = ?, source_hash = ?, detail_json = ? WHERE id = ?", source, hash, mustJSON(item.Detail), item.ID); err != nil {
			return err
		}
	} else if hash != item.SourceHash {
		return s.stopTranslationItems(ctx, []translationItem{item}, "source_changed")
	}
	// The transcript or file is checked as a whole before any chunk leaves.
	input, err := loadLLMWorkInput(ctx, s.db, item.WorkID)
	if err != nil {
		return s.stopTranslationItems(ctx, []translationItem{item}, "source_changed")
	}
	if !llmAllowed(assessLLMTranslation(send.policy, input, llm.Text{Lyrics: lines}).Class, send.provider) {
		return s.stopTranslationItems(ctx, []translationItem{item}, "policy_blocked")
	}
	translated := append([]string{}, item.Checkpoint...)
	for index := item.RequestIndex; index < chunks; index++ {
		if index > item.RequestIndex {
			if s.asrShouldYield(ctx, job.ID) {
				return errAITranslationYield
			}
			if code := s.recheckTranslationSend(ctx, item, send); code != "" {
				return s.stopTranslationItems(ctx, []translationItem{item}, code)
			}
		}
		if err := s.markTranslationRequesting(ctx, job.RunID, []translationItem{item}); err != nil {
			return err
		}
		chunk := lines[index*llm.LyricsChunkLines : min((index+1)*llm.LyricsChunkLines, len(lines))]
		result, requestErr := send.client.Translate(ctx, item.Model, item.Detail.SourceLanguage, item.Language, llm.Text{Lyrics: chunk})
		if requestErr != nil {
			return s.failTranslationRequest(ctx, []translationItem{item}, requestErr)
		}
		translated = append(translated, result.Lyrics...)
		if len(strings.Join(translated, "\n")) > llm.LyricsLimit {
			_, err := s.db.ExecContext(ctx, "UPDATE translation_item SET state = 'failed', failure_code = 'translation_output_too_large', updated_at = CURRENT_TIMESTAMP WHERE id = ?", item.ID)
			return err
		}
		if _, err := s.db.ExecContext(ctx, `UPDATE translation_item SET state = 'queued', request_index = ?, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND state = 'requesting'`, index+1, mustJSON(translated), item.ID); err != nil {
			return err
		}
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "translating", map[string]any{"run_id": job.RunID, "language": item.Language}, index+1, chunks); err != nil {
			return err
		}
	}
	text, err := document.Render(translated)
	if err != nil {
		_, err := s.db.ExecContext(ctx, "UPDATE translation_item SET state = 'failed', failure_code = 'invalid_lyrics_output', updated_at = CURRENT_TIMESTAMP WHERE id = ?", item.ID)
		return err
	}
	attribute, err := s.lyricsAttributionEnabled(ctx)
	if err != nil {
		return err
	}
	if attribute {
		if attributed, err := llm.AddAttribution(document.Format, text, llm.Attribution(item.Language, item.Detail.ASRModel, item.Model)); err == nil {
			text = attributed
		}
	}
	return s.finishTranslationItem(ctx, item, text)
}

// finishAITranslationJob settles the job and its run from its items: the run
// succeeds when every item reached review, is partial when some stopped, and
// fails when none reached review.
func (s *Server) finishAITranslationJob(ctx context.Context, job workflowJobRecord) error {
	counts := map[string]int{}
	rows, err := s.db.QueryContext(ctx, "SELECT state, COUNT(*) FROM translation_item WHERE workflow_run_id = ? GROUP BY state", job.RunID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var state string
		var count int
		if err := rows.Scan(&state, &count); err != nil {
			_ = rows.Close()
			return err
		}
		counts[state] = count
	}
	if err := rows.Close(); err != nil {
		return err
	}
	stopped := counts["failed"] + counts["uncertain"] + counts["invalid"] + counts["policy_blocked"]
	reviewed := counts["ready"] + counts["accepted"] + counts["rejected"]
	status, jobStatus := "succeeded", "succeeded"
	switch {
	case stopped > 0 && reviewed == 0:
		status, jobStatus = "failed", "failed"
	case stopped > 0:
		status = "partial"
	}
	summary := map[string]any{"status": status, "items": counts}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	message := ""
	if jobStatus == "failed" {
		message = "Translation stopped: no item reached review"
	}
	result, err := tx.ExecContext(ctx, `UPDATE workflow_job SET status = ?, error_message = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status = 'running'`, jobStatus, message, job.ID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return errors.New("translation job has already settled")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(summary), message, job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", status, mustJSON(summary), job.RunID); err != nil {
		return err
	}
	level := "info"
	if stopped > 0 {
		level = "warning"
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{NodeRunID: job.NodeRunID, JobID: job.ID, Level: level, Type: "translation.ready_for_review", Message: "Translations are ready for review", Detail: summary}); err != nil {
		return err
	}
	return tx.Commit()
}
