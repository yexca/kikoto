package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os/exec"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// aiTranslationRequest is one Translate with AI submission for one work.
type aiTranslationRequest struct {
	Languages []string `json:"languages"`
	// Categories are title, description, tags and files; lyrics are listed
	// track by track.
	Categories []string `json:"categories"`
	ProviderID string   `json:"providerId"`
	Model      string   `json:"model,omitempty"`
	// Lyrics are the tracks and languages to translate. An entry without a
	// lyrics file is transcribed first.
	Lyrics        []aiLyricsTarget `json:"lyrics"`
	ASRProviderID string           `json:"asrProviderId"`
	ASRModel      string           `json:"asrModel,omitempty"`
	// DirectASR lets a speech model that writes the one requested language
	// from the track's speech write it directly instead of transcribing the
	// original language for translation.
	DirectASR bool `json:"directAsr"`
}

type aiLyricsTarget struct {
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	TargetLanguage   string `json:"targetLanguage"`
	LyricsLocationID int64  `json:"lyricsLocationId"`
}

// aiTranslationSkip names an object a submission left out and why.
type aiTranslationSkip struct {
	Category string `json:"category"`
	Language string `json:"language,omitempty"`
	Subject  string `json:"subject,omitempty"`
	Reason   string `json:"reason"`
}

type aiTranslationRunResponse struct {
	RunID   int64               `json:"runId"`
	Items   int                 `json:"items"`
	Skipped []aiTranslationSkip `json:"skipped"`
}

func (s *Server) createAITranslation(w http.ResponseWriter, r *http.Request) {
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
	var body aiTranslationRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil {
		writeAPIError(w, 400, "invalid_translation_request", "Invalid translation request.", false)
		return
	}
	response, err := s.submitAITranslation(r.Context(), actor, workID, body)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, 404, "work_not_found", "Work not found.", false)
		return
	}
	if err != nil {
		writeLLMRequestError(w, err)
		return
	}
	writeJSON(w, 202, response)
}

// pendingTranscription is a track a submission transcribes.
type pendingTranscription struct {
	id       string
	track    localTrack
	language string
	// targets are the languages translated from the transcription.
	targets []string
}

func (s *Server) submitAITranslation(ctx context.Context, actor currentUser, workID int64, body aiTranslationRequest) (aiTranslationRunResponse, error) {
	response := aiTranslationRunResponse{Skipped: []aiTranslationSkip{}}
	languages, ok := translationPlanLanguages(body.Languages)
	if !ok {
		return response, llmInvalid("invalid_translation_request", "Choose supported target languages.")
	}
	categories := []string{}
	for _, category := range body.Categories {
		switch category {
		case "title":
			categories = append(categories, translationTitle)
		case "description":
			categories = append(categories, translationDescription)
		case "tags":
			categories = append(categories, translationTag)
		case "files":
			categories = append(categories, translationFileName, translationFolderName)
		default:
			return response, llmInvalid("invalid_translation_request", "Choose supported translation categories.")
		}
	}
	if len(body.Lyrics) > aiTranslationMaxLyrics {
		return response, llmInvalid("invalid_translation_request", "Too many lyrics translations in one request.")
	}
	for _, category := range categories {
		if !hasTranslationPermissions(actor, category) {
			return response, llmInvalid("llm_permission_changed", "You cannot translate one of the chosen categories.")
		}
	}
	if len(body.Lyrics) > 0 && !hasTranslationPermissions(actor, translationLyrics) {
		return response, llmInvalid("llm_permission_changed", "You cannot translate lyrics.")
	}
	var code string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		return response, err
	}
	origin := s.workOriginLyricsLanguage(ctx, workID)
	candidates, err := s.translationCandidates(ctx, workID, languages, categories)
	if err != nil {
		return response, err
	}
	type plannedItem struct {
		language   string
		candidate  translationCandidate
		engine     string
		state      string
		transcribe *pendingTranscription
	}
	planned := []plannedItem{}
	names := 0
	for _, language := range languages {
		for _, candidate := range candidates.byLanguage[language] {
			if candidate.Category == translationFileName || candidate.Category == translationFolderName {
				if names >= aiTranslationMaxNames {
					response.Skipped = append(response.Skipped, aiTranslationSkip{candidate.Category, language, candidate.Subject, "too_many_names"})
					continue
				}
				names++
			}
			planned = append(planned, plannedItem{language: language, candidate: candidate, engine: "llm", state: "queued"})
		}
	}

	// Lyrics are read from a chosen file, or transcribed once per track.
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return response, err
	}
	transcriptions := map[int64]*pendingTranscription{}
	transcriptionOrder := []int64{}
	for _, target := range body.Lyrics {
		if !slices.Contains(languages, target.TargetLanguage) {
			return response, llmInvalid("invalid_translation_request", "Each lyrics translation needs one of the chosen languages.")
		}
		subject := strconv.FormatInt(target.AudioMediaItemID, 10)
		track, err := s.loadLocalTrack(ctx, target.AudioMediaItemID)
		if errors.Is(err, errLocalTrackUnavailable) || err == nil && !family[track.WorkID] {
			response.Skipped = append(response.Skipped, aiTranslationSkip{translationLyrics, target.TargetLanguage, subject, "track_unavailable"})
			continue
		}
		if err != nil {
			return response, err
		}
		var assigned bool
		if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM media_lyrics_assignment WHERE audio_media_item_id = ? AND language = ?)", track.AudioID, target.TargetLanguage).Scan(&assigned); err != nil {
			return response, err
		}
		if assigned {
			response.Skipped = append(response.Skipped, aiTranslationSkip{translationLyrics, target.TargetLanguage, subject, "has_lyrics"})
			continue
		}
		if target.LyricsLocationID > 0 {
			detail, err := s.lyricsSourceDetail(ctx, family, track, target.LyricsLocationID, origin)
			if err != nil {
				response.Skipped = append(response.Skipped, aiTranslationSkip{translationLyrics, target.TargetLanguage, subject, "source_unavailable"})
				continue
			}
			planned = append(planned, plannedItem{language: target.TargetLanguage, engine: "llm", state: "queued",
				candidate: translationCandidate{WorkID: track.WorkID, Category: translationLyrics, Subject: subject, Detail: detail}})
			continue
		}
		pending := transcriptions[track.AudioID]
		if pending == nil {
			pending = &pendingTranscription{track: track}
			transcriptions[track.AudioID] = pending
			transcriptionOrder = append(transcriptionOrder, track.AudioID)
		}
		if !slices.Contains(pending.targets, target.TargetLanguage) {
			pending.targets = append(pending.targets, target.TargetLanguage)
		}
	}

	var asrProvider asr.Provider
	var asrModel string
	if len(transcriptions) > 0 {
		asrProvider, asrModel, err = s.translationASRProvider(ctx, body)
		if err != nil {
			return response, err
		}
		if _, err := exec.LookPath("ffmpeg"); err != nil {
			return response, llmInvalid("asr_ffmpeg_unavailable", "Audio preparation is unavailable on this server.")
		}
		if origin == "" {
			return response, llmInvalid("asr_origin_unknown", "The work's original language is unknown, so its speech cannot be transcribed.")
		}
		allowed, err := s.asrAllowed(ctx, workID, asrProvider)
		if err != nil {
			return response, err
		}
		// A speech model that writes the one requested language directly
		// writes it; any other combination transcribes the original language
		// once per track and translates every language from it.
		targetSet := []string{}
		for _, audioID := range transcriptionOrder {
			for _, language := range transcriptions[audioID].targets {
				if !slices.Contains(targetSet, language) {
					targetSet = append(targetSet, language)
				}
			}
		}
		direct := body.DirectASR && len(targetSet) == 1 && targetSet[0] != origin && asrProvider.Writes(asrModel, origin, targetSet[0])
		if !direct && !asrProvider.Writes(asrModel, origin, origin) {
			return response, llmInvalid("asr_language_unsupported", "The speech model does not write the work's original language.")
		}
		for _, audioID := range transcriptionOrder {
			pending := transcriptions[audioID]
			subject := strconv.FormatInt(audioID, 10)
			skip := ""
			var running bool
			if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM asr_transcription WHERE audio_media_item_id = ? AND state IN ('pending', 'requesting'))", audioID).Scan(&running); err != nil {
				return response, err
			}
			switch {
			case !allowed:
				skip = "asr_policy_blocked"
			case running:
				skip = "transcription_running"
			case pending.track.DurationSeconds > asrMaxAudioSeconds:
				skip = "asr_audio_too_long"
			}
			if skip != "" {
				for _, language := range pending.targets {
					response.Skipped = append(response.Skipped, aiTranslationSkip{translationLyrics, language, subject, skip})
				}
				delete(transcriptions, audioID)
				continue
			}
			pending.language = origin
			if direct {
				pending.language = targetSet[0]
			}
			planned = append(planned, plannedItem{language: pending.language, engine: "asr", state: "queued", transcribe: pending,
				candidate: translationCandidate{WorkID: pending.track.WorkID, Category: translationLyrics, Subject: subject,
					Detail: translationItemDetail{FolderID: pending.track.FolderID, Extension: ".vtt", SourceLanguage: origin, ASRModel: asrModel}}})
			for _, language := range pending.targets {
				if language == pending.language {
					continue
				}
				planned = append(planned, plannedItem{language: language, engine: "llm", state: "waiting_transcription", transcribe: pending,
					candidate: translationCandidate{WorkID: pending.track.WorkID, Category: translationLyrics, Subject: subject,
						Detail: translationItemDetail{FolderID: pending.track.FolderID, Extension: ".vtt", SourceLanguage: origin, ASRModel: asrModel}}})
			}
		}
	}

	// Every translated item names one LLM model; a run of transcriptions that
	// write their target directly needs none.
	var provider llm.Provider
	var model string
	var policyHash, configHash string
	needsLLM := slices.ContainsFunc(planned, func(item plannedItem) bool { return item.engine == "llm" })
	if needsLLM {
		provider, err = s.llmProvider(ctx, body.ProviderID)
		var enabled bool
		model, enabled = provider.ResolveModel(body.Model)
		if err != nil || !provider.Enabled || !enabled {
			return response, llmInvalid("llm_not_ready", "Choose an enabled provider and model.")
		}
		for _, language := range languages {
			if !provider.TranslatesDirection(model, origin, language) {
				return response, errLLMUnsupportedLanguagePair
			}
		}
		policy, err := s.llmStore.Policy(ctx)
		if err != nil {
			return response, err
		}
		policyHash, configHash = llmValueHash(policy), s.llmConfigHash(provider, model)
		// Work metadata is checked now; lyrics are checked when their text is
		// read, before it is sent.
		if slices.ContainsFunc(planned, func(item plannedItem) bool { return item.candidate.Category != translationLyrics }) {
			input, err := loadLLMWorkInput(ctx, s.db, workID)
			if err != nil {
				return response, err
			}
			source := llm.Text{}
			for _, item := range planned {
				switch item.candidate.Category {
				case translationTitle:
					source.Title = item.candidate.SourceText
				case translationDescription:
					source.Description = item.candidate.SourceText
				case translationTag, translationFileName, translationFolderName:
					source.Tags = append(source.Tags, item.candidate.SourceText)
				}
			}
			if !llmAllowed(assessLLMTranslation(policy, input, source).Class, provider) {
				return response, llmInvalid("llm_policy_blocked", "Content policy blocks this translation. The content exceeds the provider receive maximum, or its class is unknown or blocked.")
			}
		}
	}
	if len(planned) == 0 {
		return response, llmInvalid("nothing_to_translate", "Everything chosen already has a value, or is being translated.")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return response, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, aiTranslationWorkflowCode, "Translate with AI", "Transcribe and translate one work's missing text for review.",
		map[string]any{"nodes": []map[string]string{{"id": "translate", "type": aiTranslationWorkerType, "displayName": "Translate for review"}}})
	if err != nil {
		return response, err
	}
	input := map[string]any{workflowRunRequesterKey: actor.ID, "work_id": workID, "work_code": code, "languages": languages,
		"categories": body.Categories, "provider_id": provider.ID, "model": model, "asr_provider_id": asrProvider.ID, "asr_model": asrModel}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, aiTranslationWorkflowCode, "Translate "+code, "queued", "manual", "work_translation", input, map[string]any{})
	if err != nil {
		return response, err
	}
	for _, audioID := range transcriptionOrder {
		pending := transcriptions[audioID]
		if pending == nil {
			continue
		}
		var token [16]byte
		if _, err := rand.Read(token[:]); err != nil {
			return response, err
		}
		pending.id = hex.EncodeToString(token[:])
		if _, err := tx.ExecContext(ctx, `INSERT INTO asr_transcription(id,workflow_run_id,user_id,work_id,audio_media_item_id,audio_location_id,folder_id,provider_id,provider_name,model,audio_language,language,config_hash,source_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			pending.id, runID, actor.ID, pending.track.WorkID, pending.track.AudioID, pending.track.LocationID, pending.track.FolderID, asrProvider.ID, asrProvider.Name, asrModel, origin, pending.language, s.asrConfigHash(asrProvider, asrModel), pending.track.Version); err != nil {
			return response, err
		}
	}
	for _, item := range planned {
		transcriptionID := any(nil)
		if item.transcribe != nil {
			transcriptionID = item.transcribe.id
		}
		providerID, itemModel, itemConfig, itemPolicy := provider.ID, model, configHash, policyHash
		if item.engine == "asr" {
			providerID, itemModel, itemConfig, itemPolicy = asrProvider.ID, asrModel, s.asrConfigHash(asrProvider, asrModel), ""
		}
		result, err := tx.ExecContext(ctx, `INSERT INTO translation_item(workflow_run_id,work_id,requested_by_user_id,language,category,subject,engine,dedup_key,state,asr_transcription_id,detail_json,source_text,source_hash,provider_id,model,config_hash,policy_hash)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
			runID, item.candidate.WorkID, actor.ID, item.language, item.candidate.Category, item.candidate.Subject, item.engine,
			item.candidate.key(item.language), item.state, transcriptionID, mustJSON(item.candidate.Detail), item.candidate.SourceText,
			llmValueHash(item.candidate.SourceText), providerID, itemModel, itemConfig, itemPolicy)
		if err != nil {
			return response, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return response, err
		}
		if count == 0 {
			response.Skipped = append(response.Skipped, aiTranslationSkip{item.candidate.Category, item.language, item.candidate.Subject, "already_active"})
			continue
		}
		response.Items++
	}
	if response.Items == 0 {
		return response, llmInvalid("nothing_to_translate", "Everything chosen already has a value, or is being translated.")
	}
	// A transcription none of whose items was created is not run.
	if _, err := tx.ExecContext(ctx, `DELETE FROM asr_transcription WHERE workflow_run_id = ?
		AND NOT EXISTS (SELECT 1 FROM translation_item WHERE asr_transcription_id = asr_transcription.id)`, runID); err != nil {
		return response, err
	}
	nodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{NodeID: "translate", NodeType: aiTranslationWorkerType, DisplayName: "Translate for review", Position: 1, Status: "queued", Input: input})
	if err != nil {
		return response, err
	}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{NodeRunID: nodeID, WorkerType: aiTranslationWorkerType, Status: "queued",
		Priority: workflowJobPriorityForTrigger("manual"), ResourceKey: "ai:translation", Payload: aiTranslationJobPayload{UserID: actor.ID},
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3}); err != nil {
		return response, err
	}
	if err := tx.Commit(); err != nil {
		return response, err
	}
	response.RunID = runID
	return response, nil
}

// translationASRProvider resolves the speech recognition service and model
// of a submission.
func (s *Server) translationASRProvider(ctx context.Context, body aiTranslationRequest) (asr.Provider, string, error) {
	provider, err := s.asrStore.Get(ctx, body.ASRProviderID)
	model, enabled := provider.ResolveModel(body.ASRModel)
	if err != nil || !provider.Enabled || !enabled {
		return provider, "", llmInvalid("asr_not_ready", "Choose an enabled speech recognition service with a model.")
	}
	return provider, model, nil
}

// lyricsSourceDetail checks that a lyrics file belongs to the work family
// and names its language: the language a track has it assigned in, else the
// work's original language.
func (s *Server) lyricsSourceDetail(ctx context.Context, family map[int64]bool, track localTrack, locationID int64, origin string) (translationItemDetail, error) {
	detail := translationItemDetail{SourceLocationID: locationID, FolderID: track.FolderID, SourceLanguage: origin}
	var lyricsItemID, itemWorkID int64
	var kind, relative, availability, title string
	err := s.db.QueryRowContext(ctx, `SELECT item.id, item.work_id, item.kind, item.title, location.path, location.availability
		FROM media_file_location AS location INNER JOIN media_item AS item ON item.id = location.media_item_id WHERE location.id = ?`, locationID).
		Scan(&lyricsItemID, &itemWorkID, &kind, &title, &relative, &availability)
	if err != nil {
		return detail, err
	}
	if !family[itemWorkID] || kind != "text" || availability != "available" && availability != "remote" {
		return detail, errors.New("lyrics source is outside the work")
	}
	detail.Extension = strings.ToLower(path.Ext(relative))
	detail.SourceTitle = title
	var language string
	err = s.db.QueryRowContext(ctx, "SELECT language FROM media_lyrics_assignment WHERE audio_media_item_id = ? AND lyrics_media_item_id = ? ORDER BY language DESC LIMIT 1", track.AudioID, lyricsItemID).Scan(&language)
	if err == nil && language != "" {
		detail.SourceLanguage = language
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return detail, err
	}
	return detail, nil
}
