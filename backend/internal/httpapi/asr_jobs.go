package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"time"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/kikotohelper"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	asrWorkerType = "asr_transcription"
	// asrChunkSeconds is the longest audio one request carries. Its 16 kHz
	// mono WAV stays well below the 25 MB upload limit of hosted services.
	asrChunkSeconds = 300
	// asrCutSearchSeconds is how far back from a chunk's end a quiet cut point
	// is searched.
	asrCutSearchSeconds = 60
	asrMaxAudioSeconds  = 12 * 60 * 60
	// asrRequestTimeout bounds one chunk request; a CPU service can take
	// longer than the chunk itself.
	asrRequestTimeout   = 30 * time.Minute
	asrExtractTimeout   = 2 * time.Minute
	asrCuesLimit        = 4 << 20
	asrTranscriptLimit  = 2 << 20
	asrYieldDelay       = 5 * time.Second
	asrResultUnknown    = "upstream_result_unknown"
	asrFailureCancelled = "cancelled"
)

type asrJobPayload struct {
	TranscriptionID string `json:"transcription_id"`
	UserID          int64  `json:"requested_by_user_id"`
}

type asrTask struct {
	ID            string
	RunID         int64
	UserID        int64
	WorkID        int64
	AudioID       int64
	LocationID    int64
	ProviderID    string
	Model         string
	AudioLanguage string
	Language      string
	ConfigHash    string
	SourceVersion string
	State         string
	OffsetMS      int64
	Cues          []asr.Cue
}

func (s *Server) loadASRTask(ctx context.Context, id string) (asrTask, error) {
	var task asrTask
	var userID sql.NullInt64
	var cues string
	err := s.db.QueryRowContext(ctx, `SELECT id,workflow_run_id,user_id,work_id,audio_media_item_id,audio_location_id,provider_id,model,audio_language,language,config_hash,source_version,state,offset_ms,cues_json FROM asr_transcription WHERE id=?`, id).Scan(
		&task.ID, &task.RunID, &userID, &task.WorkID, &task.AudioID, &task.LocationID, &task.ProviderID, &task.Model, &task.AudioLanguage, &task.Language, &task.ConfigHash, &task.SourceVersion, &task.State, &task.OffsetMS, &cues)
	if err != nil {
		return task, err
	}
	task.UserID = userID.Int64
	return task, json.Unmarshal([]byte(cues), &task.Cues)
}

// failASRTask records a fixed failure code; diagnostics never carry the
// endpoint, key, file path or transcript.
func (s *Server) failASRTask(ctx context.Context, job workflowJobRecord, task asrTask, code string) error {
	ctx = context.WithoutCancel(ctx)
	if _, err := s.db.ExecContext(ctx, "UPDATE asr_transcription SET state='failed',failure_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state IN ('pending','requesting','failed')", code, task.ID); err != nil {
		return err
	}
	message := "Transcription stopped: " + code
	if err := s.failClaimedWorkflowJob(ctx, job, message); err != nil {
		return err
	}
	return errors.New(message)
}

// executeASRTranscriptionJob transcribes a track one chunk at a time. Each
// chunk's cues commit before the next request, so a restart or manual retry
// continues after the last finished chunk. Between chunks the job yields the
// single workflow executor to other queued work.
func (s *Server) executeASRTranscriptionJob(ctx context.Context, job workflowJobRecord) error {
	return s.executeASRTranscriptionWithDecoder(ctx, job, extractASRChunk)
}

func (s *Server) executeASRTranscriptionWithDecoder(ctx context.Context, job workflowJobRecord, decode func(context.Context, string, string, int64, int) ([]byte, error)) error {
	var payload asrJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		return errors.New("invalid transcription job")
	}
	task, err := s.loadASRTask(ctx, payload.TranscriptionID)
	if err != nil {
		return errors.New("transcription task is unavailable")
	}
	if task.RunID != job.RunID || task.UserID != payload.UserID {
		return errors.New("transcription job scope mismatch")
	}
	switch task.State {
	case "pending", "failed":
	case "requesting":
		// A request was in flight when the process stopped. Sending it again
		// may be billed twice, so only an explicit retry resends it.
		return s.failASRTask(ctx, job, task, asrResultUnknown)
	case "ready", "publishing", "accepted", "rejected":
		return s.finishASRTranscriptionJob(ctx, job, task.ID)
	default:
		return s.failASRTask(ctx, job, task, asrFailureCancelled)
	}
	ffmpeg, err := exec.LookPath("ffmpeg")
	if err != nil {
		return s.failASRTask(ctx, job, task, "ffmpeg_unavailable")
	}
	provider, code := s.checkASRSend(ctx, task)
	if code != "" {
		return s.failASRTask(ctx, job, task, code)
	}
	client, closeClient, err := s.asrClient(ctx, provider, asrRequestTimeout)
	if err != nil {
		return s.failASRTask(ctx, job, task, "endpoint_unavailable")
	}
	defer closeClient()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, code := s.checkASRSend(ctx, task); code != "" {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return s.failASRTask(ctx, job, task, code)
		}
		source, err := s.loadLocalTrack(ctx, task.AudioID)
		if err != nil || source.LocationID != task.LocationID || source.Version != task.SourceVersion {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return s.failASRTask(ctx, job, task, "source_changed")
		}
		if task.OffsetMS >= asrMaxAudioSeconds*1000 {
			return s.failASRTask(ctx, job, task, "audio_too_long")
		}
		input, err := safeDataPath(s.cfg.DataRoot, source.Path)
		if err != nil {
			return s.failASRTask(ctx, job, task, "source_changed")
		}
		if err := s.ensureLibraryPathOnline(ctx, source.Path); err != nil {
			return s.failASRTask(ctx, job, task, "source_unavailable")
		}
		if info, err := os.Stat(input); err != nil || !info.Mode().IsRegular() {
			return s.failASRTask(ctx, job, task, "source_unavailable")
		}
		pcm, err := decode(ctx, ffmpeg, input, task.OffsetMS, asrChunkSeconds)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.Warn("speech transcription audio preparation failed", "run_id", job.RunID, "audio_media_item_id", task.AudioID, "error", err)
			return s.failASRTask(ctx, job, task, "audio_decode_failed")
		}
		if len(pcm) < asr.BytesPerSecond/10 {
			break
		}
		last := len(pcm) < asrChunkSeconds*asr.BytesPerSecond
		send := pcm
		if !last {
			send = pcm[:asr.QuietCut(pcm, asrCutSearchSeconds)]
		}
		durationMS := int64(len(send)) * 1000 / asr.BytesPerSecond
		// Decoding can take minutes. Recheck the send boundary after it, while
		// no audio has left the server and the request is still safe to refuse.
		if _, code := s.checkASRSend(ctx, task); code != "" {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return s.failASRTask(ctx, job, task, code)
		}
		// The cancellation check and the in-flight marker commit together.
		result, err := s.db.ExecContext(ctx, `UPDATE asr_transcription SET state='requesting',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state IN ('pending','failed') AND NOT EXISTS(SELECT 1 FROM workflow_run WHERE id=? AND status='cancelled')`, task.ID, job.RunID)
		if err != nil {
			return err
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			return errors.New("transcription task cannot send a request")
		}
		// A translating model is asked for the lyrics language it writes.
		target := ""
		if task.AudioLanguage != task.Language {
			target = task.Language
		}
		transcript, requestErr := client.Transcribe(ctx, task.Model, asr.RequestLanguage(task.AudioLanguage), target, send)
		if requestErr != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			code := "upstream_failed"
			var rejected asr.UpstreamError
			switch {
			case errors.As(requestErr, &rejected) && kikotohelper.Failure(rejected.Rejection) != "":
				code = kikotohelper.Failure(rejected.Rejection)
			case errors.As(requestErr, &rejected):
				code = "upstream_rejected"
			case errors.Is(requestErr, asr.ErrNoTimestamps):
				code = "no_timestamps"
			}
			slog.Warn("speech transcription request failed", "run_id", job.RunID, "provider", task.ProviderID, "error", requestErr)
			return s.failASRTask(ctx, job, task, code)
		}
		task.Cues = append(task.Cues, asr.ChunkCues(transcript.Segments, task.OffsetMS, durationMS)...)
		cues, err := json.Marshal(task.Cues)
		if err != nil {
			return err
		}
		if len(cues) > asrCuesLimit {
			return s.failASRTask(ctx, job, task, "transcript_too_large")
		}
		task.OffsetMS += durationMS
		result, err = s.db.ExecContext(ctx, "UPDATE asr_transcription SET state='pending',offset_ms=?,cues_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND state='requesting'", task.OffsetMS, string(cues), task.ID)
		if err != nil {
			return s.failASRTask(ctx, job, task, asrResultUnknown)
		}
		if count, err := result.RowsAffected(); err != nil || count != 1 {
			return errors.New("transcription task changed during a request")
		}
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "transcribing", map[string]any{"work_id": task.WorkID, "audio_media_item_id": task.AudioID}, int(task.OffsetMS/1000), int(source.DurationSeconds)); err != nil {
			return err
		}
		if last {
			break
		}
		if s.asrShouldYield(ctx, job.ID) {
			return s.deferWorkflowJob(ctx, job, asrYieldDelay, "Transcription yields to other queued work between chunks")
		}
	}
	if len(task.Cues) == 0 {
		return s.failASRTask(ctx, job, task, "no_speech")
	}
	text := asr.RenderVTT(task.Cues)
	if len(text) > asrTranscriptLimit {
		return s.failASRTask(ctx, job, task, "transcript_too_large")
	}
	result, err := s.db.ExecContext(ctx, "UPDATE asr_transcription SET state='ready',value_text=?,cues_json='[]',failure_code='',updated_at=CURRENT_TIMESTAMP WHERE id=? AND state IN ('pending','failed') AND NOT EXISTS(SELECT 1 FROM workflow_run WHERE id=? AND status='cancelled')", text, task.ID, job.RunID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return errors.New("transcription run was cancelled")
	}
	return s.finishASRTranscriptionJob(ctx, job, task.ID)
}

// checkASRSend rechecks, before every request, that the requester may still
// transcribe, that the service is the one the task was created for, and that
// the content policy still allows sending the work's audio there.
func (s *Server) checkASRSend(ctx context.Context, task asrTask) (asr.Provider, string) {
	if task.UserID == 0 {
		return asr.Provider{}, "permission_changed"
	}
	actor, err := s.accountStore.LoadByID(ctx, task.UserID)
	if err != nil || !userHasPermission(actor, "library:write") || !userHasPermission(actor, "workflows:run") {
		return asr.Provider{}, "permission_changed"
	}
	provider, err := s.asrStore.Get(ctx, task.ProviderID)
	if err != nil || !provider.Enabled || s.asrConfigHash(provider, task.Model) != task.ConfigHash {
		return asr.Provider{}, "provider_changed"
	}
	allowed, err := s.asrAllowed(ctx, task.WorkID, provider)
	if err != nil || !allowed {
		return asr.Provider{}, "policy_blocked"
	}
	return provider, ""
}

// asrShouldYield reports whether another job is waiting for the executor.
func (s *Server) asrShouldYield(ctx context.Context, jobID int64) bool {
	var waiting bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.status = 'queued' AND run.status = 'queued' AND job.id <> ?
			AND (job.available_at IS NULL OR job.available_at <= CURRENT_TIMESTAMP)
	)`, jobID).Scan(&waiting)
	return err == nil && waiting
}

// extractASRChunk decodes up to seconds of the input's first audio stream,
// starting at offsetMS, as 16 kHz mono 16-bit PCM. An offset past the end
// returns no samples.
func extractASRChunk(ctx context.Context, ffmpeg string, input string, offsetMS int64, seconds int) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, asrExtractTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, ffmpeg,
		"-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
		"-ss", fmt.Sprintf("%d.%03d", offsetMS/1000, offsetMS%1000), "-t", strconv.Itoa(seconds),
		"-protocol_whitelist", "file,pipe", "-i", input,
		"-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn",
		"-ac", "1", "-ar", strconv.Itoa(asr.SampleRate), "-f", "s16le", "pipe:1",
	)
	diagnostics := &transcodeDiagnosticOutput{}
	command.Stderr = diagnostics
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := command.Start(); err != nil {
		return nil, err
	}
	limit := int64(seconds+1) * asr.BytesPerSecond
	pcm, readErr := io.ReadAll(io.LimitReader(stdout, limit+1))
	if int64(len(pcm)) > limit {
		_ = command.Process.Kill()
		_ = command.Wait()
		return nil, errors.New("decoded audio exceeded its chunk bound")
	}
	if err := command.Wait(); err != nil {
		return nil, fmt.Errorf("ffmpeg failed: %w: %s", err, diagnostics.String())
	}
	if readErr != nil {
		return nil, readErr
	}
	return pcm[:len(pcm)-len(pcm)%2], nil
}

func (s *Server) finishASRTranscriptionJob(ctx context.Context, job workflowJobRecord, id string) error {
	summary := map[string]any{"status": "ready_for_review", "transcription_id": id}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, "UPDATE workflow_job SET status='succeeded',locked_by='',locked_at=NULL,heartbeat_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", job.ID)
	if err != nil {
		return err
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return errors.New("transcription job has already settled")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status='succeeded',output_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=?", mustJSON(summary), job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status='succeeded',summary_json=?,finished_at=CURRENT_TIMESTAMP WHERE id=? AND status='running'", mustJSON(summary), job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{NodeRunID: job.NodeRunID, JobID: job.ID, Level: "info", Type: "asr.ready_for_review", Message: "Transcription is ready for review", Detail: summary}); err != nil {
		return err
	}
	return tx.Commit()
}

// retryASRTranscriptionRun resumes a failed transcription after its last
// finished chunk. A chunk whose request was in flight is sent again.
func (s *Server) retryASRTranscriptionRun(ctx context.Context, actor currentUser, runID int64) (workflowRetryDispatchResult, error) {
	if !userHasPermission(actor, "library:write") {
		return workflowRetryDispatchResult{}, errWorkflowRetryPermission
	}
	var state string
	if err := s.db.QueryRowContext(ctx, "SELECT state FROM asr_transcription WHERE workflow_run_id=?", runID).Scan(&state); err != nil {
		return workflowRetryDispatchResult{}, err
	}
	if state != "failed" {
		return workflowRetryDispatchResult{}, errors.New("transcription cannot be retried in its current state")
	}
	if err := s.retryFailedWorkflowJobFor(ctx, &actor, runID); err != nil {
		return workflowRetryDispatchResult{}, err
	}
	return workflowRetryDispatchResult{NewRunID: runID, ResumedExistingRun: true}, nil
}
