package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// asrAllowed applies the content safety policy shared with LLM translation to
// the work an audio track belongs to against the service receive maximum.
// Unknown and blocked works go nowhere.
func (s *Server) asrAllowed(ctx context.Context, workID int64, p asr.Provider) (bool, error) {
	class, err := s.asrContentClass(ctx, workID)
	if err != nil {
		return false, err
	}
	return contentpolicy.Allows(class, p.MaxContentClass), nil
}

// asrContentClass is the content policy class of a work's audio: its metadata
// decides, since the audio itself is not inspected. A work that no longer
// exists is unknown.
func (s *Server) asrContentClass(ctx context.Context, workID int64) (string, error) {
	assessment, err := s.asrAssessment(ctx, workID)
	return assessment.Class, err
}

func (s *Server) asrAssessment(ctx context.Context, workID int64) (contentpolicy.Assessment, error) {
	input, err := loadLLMWorkInput(ctx, s.db, workID)
	if errors.Is(err, sql.ErrNoRows) {
		return contentpolicy.Assessment{Class: "unknown", Reason: "age rating is missing or unknown", Matches: []contentpolicy.Match{}}, nil
	}
	if err != nil {
		return contentpolicy.Assessment{}, err
	}
	policy, err := s.llmStore.Policy(ctx)
	if err != nil {
		return contentpolicy.Assessment{}, err
	}
	_, scan := llmFields(input, nil)
	return policy.Assess(input.Age, scan, input.Tags), nil
}

// asrWorkTrack resolves an audio track of a work's lyrics family that has an
// available local file, writing the refusal when there is none.
func (s *Server) asrWorkTrack(w http.ResponseWriter, r *http.Request, workID, audioID int64) (localTrack, bool) {
	family, err := s.lyricsAssignmentFamily(r.Context(), workID)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "work_not_found", "Work not found.", false)
		return localTrack{}, false
	}
	if err != nil {
		writeError(w, err)
		return localTrack{}, false
	}
	source, err := s.loadLocalTrack(r.Context(), audioID)
	if errors.Is(err, errLocalTrackUnavailable) || err == nil && !family[source.WorkID] {
		writeAPIError(w, 400, "asr_audio_unavailable", "Choose an available local audio track of this work.", false)
		return localTrack{}, false
	}
	if err != nil {
		writeError(w, err)
		return localTrack{}, false
	}
	return source, true
}

// precheckASRTranscription reports the content policy class of a track's work
// without contacting a service, so a requester can see which services may
// receive the audio before starting a transcription.
func (s *Server) precheckASRTranscription(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermissions(w, r, "library:write", "workflows:run"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	var body struct {
		AudioMediaItemID int64 `json:"audioMediaItemId"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || body.AudioMediaItemID <= 0 {
		writeAPIError(w, 400, "invalid_asr_request", "Choose an audio track.", false)
		return
	}
	source, ok := s.asrWorkTrack(w, r, workID, body.AudioMediaItemID)
	if !ok {
		return
	}
	assessment, err := s.asrAssessment(r.Context(), source.WorkID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, assessment)
}

type asrTranscriptionRequest struct {
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	ProviderID       string `json:"providerId"`
	// Model is one of the service's enabled models; empty requests the default.
	Model    string `json:"model,omitempty"`
	Language string `json:"language"`
}

func (s *Server) createASRTranscription(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	actor, ok := s.requirePermissions(w, r, "library:write", "workflows:run")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	var body asrTranscriptionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || body.AudioMediaItemID <= 0 {
		writeAPIError(w, 400, "invalid_asr_request", "Choose an audio track, a service and a language.", false)
		return
	}
	language, ok := normalizeLyricsLanguage(body.Language)
	if !ok {
		writeAPIError(w, 400, "invalid_asr_request", "Choose a supported lyrics language.", false)
		return
	}
	provider, err := s.asrStore.Get(r.Context(), body.ProviderID)
	model, enabled := provider.ResolveModel(body.Model)
	if err != nil || !provider.Enabled || !enabled {
		writeAPIError(w, 400, "asr_not_ready", "Choose an enabled speech recognition service with a model.", false)
		return
	}
	source, ok := s.asrWorkTrack(w, r, workID, body.AudioMediaItemID)
	if !ok {
		return
	}
	if source.DurationSeconds > asrMaxAudioSeconds {
		writeAPIError(w, 400, "asr_audio_too_long", "The audio track is too long to transcribe.", false)
		return
	}
	allowed, err := s.asrAllowed(r.Context(), source.WorkID, provider)
	if err != nil {
		writeError(w, err)
		return
	}
	if !allowed {
		writeAPIError(w, 400, "asr_policy_blocked", "Content policy blocks this transcription. The content exceeds the service receive maximum, or its class is unknown or blocked.", false)
		return
	}
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		writeAPIError(w, 503, "asr_ffmpeg_unavailable", "Audio preparation is unavailable on this server.", false)
		return
	}
	var existingID string
	var existingRun int64
	err = s.db.QueryRowContext(r.Context(), "SELECT id,workflow_run_id FROM asr_transcription WHERE audio_media_item_id=? AND state IN ('pending','requesting') ORDER BY created_at DESC LIMIT 1", source.AudioID).Scan(&existingID, &existingRun)
	if err == nil {
		writeJSON(w, 200, map[string]any{"id": existingID, "runId": existingRun, "state": "pending", "deduplicated": true})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		writeError(w, err)
		return
	}
	id, runID, err := s.enqueueASRTranscription(r.Context(), actor.ID, source, provider, model, language)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 202, map[string]any{"id": id, "runId": runID, "state": "pending", "deduplicated": false})
}

func (s *Server) enqueueASRTranscription(ctx context.Context, userID int64, source localTrack, provider asr.Provider, model, language string) (string, int64, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return "", 0, err
	}
	id := hex.EncodeToString(token[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var code string
	if err := tx.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id=?", source.WorkID).Scan(&code); err != nil {
		return "", 0, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, asrWorkerType, "Speech transcription", "Transcribe one local audio track into timed lyrics for review.", map[string]any{"nodes": []map[string]string{{"id": "transcribe", "type": asrWorkerType, "displayName": "Transcribe for review"}}})
	if err != nil {
		return "", 0, err
	}
	input := map[string]any{workflowRunRequesterKey: userID, "work_id": source.WorkID, "work_code": code, "audio_media_item_id": source.AudioID, "language": language}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, asrWorkerType, "Transcribe "+code, "queued", "manual", "selected_track_transcription", input, map[string]any{})
	if err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO asr_transcription(id,workflow_run_id,user_id,work_id,audio_media_item_id,audio_location_id,folder_id,provider_id,provider_name,model,language,config_hash,source_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, runID, userID, source.WorkID, source.AudioID, source.LocationID, source.FolderID, provider.ID, provider.Name, model, language, s.asrConfigHash(provider, model), source.Version); err != nil {
		return "", 0, err
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "transcribe", NodeType: asrWorkerType, DisplayName: "Transcribe for review", Position: 1, Status: "queued", Input: input})
	if err != nil {
		return "", 0, err
	}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: asrWorkerType, Status: "queued", Priority: workflowJobPriorityForTrigger("manual"), ResourceKey: "asr:transcription", Payload: asrJobPayload{TranscriptionID: id, UserID: userID}, Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true}); err != nil {
		return "", 0, err
	}
	return id, runID, tx.Commit()
}

type asrTranscriptionResponse struct {
	ID               string `json:"id"`
	RunID            int64  `json:"runId"`
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	AudioTitle       string `json:"audioTitle"`
	Language         string `json:"language"`
	ProviderName     string `json:"providerName"`
	Model            string `json:"model"`
	State            string `json:"state"`
	FailureCode      string `json:"failureCode,omitempty"`
	ProgressMS       int64  `json:"progressMs"`
	DurationMS       int64  `json:"durationMs"`
	CreatedAt        string `json:"createdAt"`
}

func (s *Server) listASRTranscriptions(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	family, err := s.lyricsAssignmentFamily(r.Context(), workID)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "work_not_found", "Work not found.", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	ids := make([]any, 0, len(family))
	for id := range family {
		ids = append(ids, id)
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT transcription.id, transcription.workflow_run_id, transcription.audio_media_item_id, item.title,
			transcription.language, transcription.provider_name, transcription.model, transcription.state,
			transcription.failure_code, transcription.offset_ms,
			COALESCE(location.duration_seconds, item.duration_seconds, 0) * 1000, transcription.created_at
		FROM asr_transcription AS transcription
		INNER JOIN media_item AS item ON item.id = transcription.audio_media_item_id
		LEFT JOIN media_file_location AS location ON location.id = transcription.audio_location_id
		WHERE transcription.work_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+`)
		ORDER BY transcription.created_at DESC, transcription.rowid DESC
		LIMIT 64
	`, ids...)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = rows.Close() }()
	result := []asrTranscriptionResponse{}
	for rows.Next() {
		var item asrTranscriptionResponse
		if err := rows.Scan(&item.ID, &item.RunID, &item.AudioMediaItemID, &item.AudioTitle, &item.Language, &item.ProviderName, &item.Model, &item.State, &item.FailureCode, &item.ProgressMS, &item.DurationMS, &item.CreatedAt); err != nil {
			writeError(w, err)
			return
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"transcriptions": result, "originLanguage": s.workOriginLyricsLanguage(r.Context(), workID)})
}

func (s *Server) asrTranscriptionText(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	var text string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_text FROM asr_transcription WHERE id=? AND state IN ('ready','publishing','accepted')", r.PathValue("transcription")).Scan(&text); err != nil {
		writeAPIError(w, 404, "asr_transcription_not_found", "Transcription not found.", false)
		return
	}
	setUntrustedFileHeaders(w)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, text)
}

func (s *Server) rejectASRTranscription(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	result, err := s.db.ExecContext(r.Context(), "UPDATE asr_transcription SET state='rejected',value_text='',cues_json='[]',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='ready'", r.PathValue("transcription"))
	if err != nil {
		writeError(w, err)
		return
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		writeAPIError(w, 409, "asr_transcription_not_ready", "Only a transcription awaiting review can be discarded.", false)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// asrLyricsNameAttempts bounds the names tried when the language's lyrics
// folder already holds a different file under the track's name.
const asrLyricsNameAttempts = 5

// acceptASRTranscription publishes a reviewed transcription as a WebVTT file
// in the language's lyrics folder of the track's work folder and assigns it to
// the track. The text is durable before publication, so a failed publication
// is completed by accepting again; an identical file already published counts
// as published.
func (s *Server) acceptASRTranscription(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeASRDisabled(w)
		return
	}
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	id := r.PathValue("transcription")
	var workID, audioID, folderID int64
	var language, text, audioPath, state string
	err := s.db.QueryRowContext(r.Context(), `
		SELECT transcription.work_id, transcription.audio_media_item_id, transcription.folder_id, transcription.language,
			transcription.value_text, transcription.state, COALESCE(location.path, '')
		FROM asr_transcription AS transcription
		LEFT JOIN media_file_location AS location ON location.id = transcription.audio_location_id
		WHERE transcription.id = ?
	`, id).Scan(&workID, &audioID, &folderID, &language, &text, &state, &audioPath)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "asr_transcription_not_found", "Transcription not found.", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if state == "accepted" {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if (state != "ready" && state != "publishing") || text == "" || audioPath == "" {
		writeAPIError(w, 409, "asr_transcription_not_ready", "Only a finished transcription can be accepted.", false)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE asr_transcription SET state='publishing',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state IN ('ready','publishing')", id); err != nil {
		writeError(w, err)
		return
	}
	lyricsPath, lyricsID, err := s.publishTrackLyrics(r.Context(), actor.ID, workID, audioID, folderID, language, audioPath, ".vtt", text, "transcription")
	if err != nil {
		var requestErr lyricsFetchRequestError
		if errors.As(err, &requestErr) {
			writeAPIError(w, requestErr.status, "asr_publish_failed", requestErr.message, false)
			return
		}
		if writeFetchDestinationError(w, err) {
			return
		}
		slog.Warn("speech transcription publication failed", "transcription", id, "work_id", workID, "error", err)
		writeAPIError(w, 500, "asr_publish_failed", "The transcription is kept; publication did not finish. Accept it again to retry.", true)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), "UPDATE asr_transcription SET state='accepted',lyrics_path=?,lyrics_media_item_id=?,cues_json='[]',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='publishing'", lyricsPath, nullableInt64(lyricsID), id); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func nullableInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}
