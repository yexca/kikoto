package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"
)

// Demo sends nothing to an LLM provider, so its Translation page shows fixed
// samples instead: a run translating and one queued, items waiting for review,
// items that stopped, and items that were applied. They name admitted works so
// their links open, every result says it is a sample, and nothing is stored.

const (
	demoTranslationModel     = "example-model"
	demoTranslationRequester = "Demo"
	// demoTranslationItemBase keeps sample item ids apart from stored ones.
	demoTranslationItemBase = 900000
)

// demoTranslationWork is an admitted work a sample names.
type demoTranslationWork struct {
	id    int64
	code  string
	title string
	tag   string
}

type demoTranslationSamples struct {
	active []translationRunResponse
	queued []translationRunResponse
	items  []translationItemResponse
}

// demoTranslationWorks reads up to three admitted works for the samples.
func (s *Server) demoTranslationWorks(ctx context.Context, userID int64) ([]demoTranslationWork, error) {
	admitted, err := demoAdmittedLocalWorks(ctx, s.db)
	if err != nil {
		return nil, err
	}
	admitted = admitted[:min(len(admitted), 3)]
	ids := make([]int64, 0, len(admitted))
	for _, work := range admitted {
		ids = append(ids, work.id)
	}
	summaries, err := s.forYouWorkSummaries(ctx, userID, ids)
	if err != nil {
		return nil, err
	}
	works := []demoTranslationWork{}
	for _, work := range admitted {
		summary, ok := summaries[work.id]
		if !ok {
			continue
		}
		sample := demoTranslationWork{id: work.id, code: work.code, title: summary.Title}
		if len(summary.Tags) > 0 {
			sample.tag = summary.Tags[0]
		}
		works = append(works, sample)
	}
	return works, nil
}

// buildDemoTranslationSamples arranges the samples over works, which may hold
// fewer than three; a missing work leaves its samples out.
func buildDemoTranslationSamples(works []demoTranslationWork, now time.Time) demoTranslationSamples {
	samples := demoTranslationSamples{
		active: []translationRunResponse{}, queued: []translationRunResponse{}, items: []translationItemResponse{},
	}
	stamp := func(ago time.Duration) string { return now.Add(-ago).UTC().Format(time.DateTime) }
	nextID := int64(demoTranslationItemBase)
	add := func(work demoTranslationWork, runID int64, language, category, subject, state string, item translationItemResponse) {
		nextID++
		item.ID, item.RunID, item.WorkID = nextID, runID, work.id
		item.WorkCode, item.WorkTitle = work.code, work.title
		item.Language, item.Category, item.Subject, item.State = language, category, subject, state
		item.Model, item.RequestedBy = demoTranslationModel, demoTranslationRequester
		if item.UpdatedAt == "" {
			item.UpdatedAt = stamp(10 * time.Minute)
		}
		samples.items = append(samples.items, item)
	}
	sampleResult := func(language string) string {
		return fmt.Sprintf("Sample %s translation; no model ran in Demo.", language)
	}

	if len(works) > 0 {
		// One run translates two languages: English waits partly for review
		// and partly for the model, Simplified Chinese is still queued.
		work := works[0]
		const runID = 1
		add(work, runID, "en-us", "title", "title", "ready", translationItemResponse{Source: work.title, Result: sampleResult("English")})
		if work.tag != "" {
			add(work, runID, "en-us", "tag", "1", "ready", translationItemResponse{Label: work.tag, Source: work.tag, Result: "Sample tag", AffectedWorks: 1})
		}
		add(work, runID, "en-us", "file_name", "2", "ready", translationItemResponse{Label: "Sample folder/Track 01.wav", Source: "Track 01", Result: "Sample track name"})
		add(work, runID, "en-us", "lyrics", "3", "requesting", translationItemResponse{Label: "Track 01", SourceTitle: "Track 01.vtt", Progress: 1, Chunks: 3})
		for index := range 3 {
			add(work, runID, "zh-cn", "file_name", strconv.Itoa(10+index), "queued", translationItemResponse{Label: fmt.Sprintf("Sample folder/Track %02d.wav", index+1)})
		}
		samples.active = append(samples.active, demoTranslationRun(work, runID, "running", stamp(4*time.Minute), samples.items))
	}
	if len(works) > 1 {
		// A second run waits its turn, and an earlier one stopped part way.
		work := works[1]
		const queuedRunID, stoppedRunID = 2, 3
		for index := range 4 {
			add(work, queuedRunID, "ko-kr", "file_name", strconv.Itoa(20+index), "queued", translationItemResponse{Label: fmt.Sprintf("Sample folder/Track %02d.wav", index+1)})
		}
		samples.queued = append(samples.queued, demoTranslationRun(work, queuedRunID, "queued", stamp(2*time.Minute), samples.items))
		add(work, stoppedRunID, "en-us", "description", "description", "failed", translationItemResponse{Source: "Sample description", FailureCode: "endpoint_unavailable"})
		add(work, stoppedRunID, "en-us", "lyrics", "30", "uncertain", translationItemResponse{Label: "Track 02", SourceTitle: "Track 02.vtt", FailureCode: "upstream_result_unknown", Chunks: 2})
		add(work, stoppedRunID, "zh-tw", "title", "title", "policy_blocked", translationItemResponse{Source: work.title, FailureCode: "policy_blocked"})
	}
	if len(works) > 2 {
		// What an earlier run wrote once it was accepted.
		work := works[2]
		const appliedRunID = 4
		add(work, appliedRunID, "zh-cn", "title", "title", "accepted", translationItemResponse{Source: work.title, Result: sampleResult("Simplified Chinese"), UpdatedAt: stamp(26 * time.Hour)})
		add(work, appliedRunID, "zh-cn", "lyrics", "40", "accepted", translationItemResponse{Label: "Track 01", SourceTitle: "Track 01.vtt", AppliedPath: "Sample folder/Track 01.zh-cn.vtt", Chunks: 2, Progress: 2, UpdatedAt: stamp(26 * time.Hour)})
	}
	return samples
}

// demoTranslationRun summarizes a sample run's items by language, as a
// stored run is.
func demoTranslationRun(work demoTranslationWork, runID int64, status, createdAt string, items []translationItemResponse) translationRunResponse {
	run := translationRunResponse{
		RunID: runID, Status: status, WorkID: work.id, WorkCode: work.code, WorkTitle: work.title,
		RequestedBy: demoTranslationRequester, CreatedAt: createdAt, Languages: []translationRunLanguage{},
	}
	for _, item := range items {
		if item.RunID != runID {
			continue
		}
		at := slices.IndexFunc(run.Languages, func(language translationRunLanguage) bool { return language.Language == item.Language })
		if at < 0 {
			run.Languages = append(run.Languages, translationRunLanguage{Language: item.Language, States: map[string]int{}})
			at = len(run.Languages) - 1
		}
		language := &run.Languages[at]
		language.States[item.State]++
		language.Total++
		if item.Category == "lyrics" {
			language.Chunks += item.Chunks
			language.ChunksDone += item.Progress
		}
	}
	for index := range run.Languages {
		language := &run.Languages[index]
		language.Stage, language.Done, language.Count = translationLanguageStage(language.States)
	}
	return run
}

// counts are the Translation page's view counts over the samples.
func (samples demoTranslationSamples) counts() map[string]int {
	counts := map[string]int{"active": len(samples.active), "queued": len(samples.queued)}
	for _, item := range samples.items {
		switch {
		case slices.Contains(translationListStates["review"], item.State):
			counts["review"]++
		case slices.Contains(translationListStates["attention"], item.State):
			counts["attention"]++
		}
	}
	return counts
}

// itemsFor lists the samples of the views given, in order, narrowed to a run
// or to works when those are set.
func (samples demoTranslationSamples) itemsFor(views []string, runID int64, workIDs []int64) []translationItemResponse {
	items := []translationItemResponse{}
	for _, view := range views {
		for _, item := range samples.items {
			if !slices.Contains(translationListStates[view], item.State) {
				continue
			}
			if runID > 0 && item.RunID != runID {
				continue
			}
			if len(workIDs) > 0 && !slices.Contains(workIDs, item.WorkID) {
				continue
			}
			items = append(items, item)
		}
	}
	return items
}

func (s *Server) demoTranslationSamples(ctx context.Context, userID int64) (demoTranslationSamples, error) {
	works, err := s.demoTranslationWorks(ctx, userID)
	if err != nil {
		return demoTranslationSamples{}, err
	}
	return buildDemoTranslationSamples(works, time.Now()), nil
}

// writeDemoTranslationRuns answers the run list with the samples of the view.
func (s *Server) writeDemoTranslationRuns(w http.ResponseWriter, r *http.Request, actor currentUser) {
	view := r.URL.Query().Get("view")
	if view == "" {
		view = "active"
	}
	if _, ok := translationRunViews[view]; !ok {
		writeAPIError(w, 400, "invalid_filter", "Invalid translation view.", false)
		return
	}
	samples, err := s.demoTranslationSamples(r.Context(), actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	runs := samples.active
	if view == "queued" {
		runs = samples.queued
	}
	writeJSON(w, 200, map[string]any{"runs": runs, "counts": samples.counts(), "autoAccept": false})
}

// writeDemoTranslationItems answers the item list with the samples of the
// views asked for, narrowed to a run or a work as a stored list is.
func (s *Server) writeDemoTranslationItems(w http.ResponseWriter, r *http.Request, actor currentUser) {
	query := r.URL.Query()
	views := []string{}
	for _, view := range query["view"] {
		if view == "" || slices.Contains(views, view) {
			continue
		}
		if _, ok := translationListStates[view]; !ok {
			writeAPIError(w, 400, "invalid_filter", "Invalid translation view.", false)
			return
		}
		views = append(views, view)
	}
	if len(views) == 0 {
		views = []string{"review"}
	}
	var runID int64
	var workIDs []int64
	if raw := query.Get("runId"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			writeAPIError(w, 400, "invalid_run_id", "Invalid run id.", false)
			return
		}
		runID = id
	}
	if raw := query.Get("workId"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
			return
		}
		workIDs = []int64{id}
	}
	samples, err := s.demoTranslationSamples(r.Context(), actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"items": samples.itemsFor(views, runID, workIDs)})
}
