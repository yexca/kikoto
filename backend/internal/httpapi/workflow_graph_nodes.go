package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func (s *Server) executeWorkflowGraphNode(ctx context.Context, runID int64, jobPriority int, payload workflowGraphJobPayload, graph workflowGraph, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	switch node.Type {
	case "circle_catalog":
		return s.executeGraphCircleCatalog(ctx, runID, node, inputs)
	case "series_catalog":
		return s.executeGraphSeriesCatalog(ctx, node, inputs)
	case "voice_catalog":
		return s.executeGraphVoiceCatalog(ctx, runID, node)
	case "circle_metadata":
		return s.executeGraphCircleMetadata(ctx, node)
	case "circle_sources":
		return s.executeGraphCircleSources(ctx, node)
	case "voice_metadata":
		return s.executeGraphVoiceMetadata(ctx, runID, node)
	case "filter_works":
		return s.executeGraphFilterWorks(ctx, payload.UserID, node, inputs)
	case "metadata_sync":
		return s.executeGraphMetadataSync(ctx, runID, node, inputs)
	case "track_works":
		return s.executeGraphTrackWorks(ctx, runID, node, inputs)
	case "fetch_works":
		return s.executeGraphFetchWorks(ctx, runID, payload.UserID, jobPriority, node, inputs)
	case "tag_works":
		return s.executeGraphTagWorks(ctx, payload.UserID, node, inputs)
	default:
		return graphNodeExecution{}, fmt.Errorf("unsupported custom workflow node: %s", node.Type)
	}
}

// executeGraphCircleCatalog combines the catalogs of every listed circle in
// input order, keeping each work once and stopping at maxWorks.
func (s *Server) executeGraphCircleCatalog(ctx context.Context, runID int64, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	circleIDs := splitPresetWorkflowTargets(firstNonEmpty(inputs["circle"].Text, configString(node.Config, "circleId")), normalizeMakerID)
	if len(circleIDs) == 0 {
		return graphNodeExecution{}, fmt.Errorf("invalid circle id")
	}
	for _, circleID := range circleIDs {
		if !dlsiteMakerIDPattern.MatchString(circleID) {
			return graphNodeExecution{}, fmt.Errorf("invalid circle id")
		}
	}
	mode := strings.ToLower(configString(node.Config, "mode"))
	if mode == "" {
		mode = "stored"
	}
	maxWorks := configInt(node.Config, "maxWorks", 100)
	codes := []string{}
	seen := map[string]bool{}
	for _, circleID := range circleIDs {
		// Only a catalog fetch may add an unknown circle; stored mode reads
		// what this site already has.
		var partyID int64
		var err error
		if mode == "stored" {
			partyID, err = s.findCircle(ctx, circleID)
		} else {
			partyID, err = s.ensurePlaceholderCircle(ctx, circleID)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return graphNodeExecution{}, fmt.Errorf("circle %s is not in the database; fetch its catalog to add it", circleID)
		}
		if err != nil {
			return graphNodeExecution{}, err
		}
		visible, err := s.circlePartyVisible(ctx, partyID)
		if err != nil {
			return graphNodeExecution{}, err
		}
		if !visible {
			return graphNodeExecution{}, fmt.Errorf("circle %s is translation-only", circleID)
		}
		if mode != "stored" {
			if _, err := s.runCircleCatalogRefresh(ctx, partyID, circleID, mode, s.newDLsiteClient()); err != nil {
				// A stop interrupts the fetch rather than failing it, so it neither
				// discards the placeholder nor records a failure.
				if !shutdownInterrupted(ctx) {
					cleanupCtx := context.WithoutCancel(ctx)
					if discarded, discardErr := s.discardUnfetchedCircle(cleanupCtx, partyID); discardErr != nil {
						slog.Warn("discard unfetched circle", "circle_id", circleID, "error", discardErr)
					} else if discarded {
						return graphNodeExecution{}, fmt.Errorf("circle %s was not added: %w", circleID, err)
					}
					s.recordCircleCatalogRefreshFailure(cleanupCtx, partyID, mode, runID)
				}
				return graphNodeExecution{}, err
			}
		}
		profile, err := s.loadCircleProfileForRefresh(ctx, partyID, circleID)
		if err != nil {
			return graphNodeExecution{}, err
		}
		for _, code := range profile.WorkCodes {
			if len(codes) >= maxWorks {
				break
			}
			if key := strings.ToUpper(code); !seen[key] {
				seen[key] = true
				codes = append(codes, code)
			}
		}
	}
	normalized, err := normalizeGraphWorkCodes(codes, maxWorks)
	if err != nil && len(codes) > 0 {
		return graphNodeExecution{}, err
	}
	return graphNodeExecution{Outputs: map[string]graphPortValue{"works": {Type: "work_candidates", Candidates: graphCandidatesForCodes(normalized, 0)}}}, nil
}

func (s *Server) executeGraphSeriesCatalog(ctx context.Context, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	seriesIDs := splitPresetWorkflowTargets(firstNonEmpty(inputs["series"].Text, configString(node.Config, "seriesId")), normalizeSeriesID)
	if len(seriesIDs) == 0 {
		return graphNodeExecution{}, fmt.Errorf("series id is required")
	}
	query := `
		SELECT DISTINCT series_work.primary_code
		FROM party_series_work AS series_work
		INNER JOIN party_series AS series ON series.id = series_work.series_id
		WHERE UPPER(series.title_id) IN (` + strings.TrimSuffix(strings.Repeat("?,", len(seriesIDs)), ",") + `)
	`
	args := []any{}
	for _, seriesID := range seriesIDs {
		args = append(args, seriesID)
	}
	if circleID := normalizeMakerID(configString(node.Config, "circleExternalId")); circleID != "" {
		query += ` AND series.party_id IN (SELECT party_id FROM party_external_id WHERE UPPER(external_id) = ?)`
		args = append(args, circleID)
	}
	query += ` ORDER BY series_work.position ASC, series_work.primary_code ASC LIMIT ?`
	maxWorks := configInt(node.Config, "maxWorks", 100)
	args = append(args, maxWorks)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return graphNodeExecution{}, err
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return graphNodeExecution{}, err
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		return graphNodeExecution{}, err
	}
	normalized := []string{}
	if len(codes) > 0 {
		normalized, err = normalizeGraphWorkCodes(codes, maxWorks)
		if err != nil {
			return graphNodeExecution{}, err
		}
	}
	return graphNodeExecution{Outputs: map[string]graphPortValue{"works": {Type: "work_candidates", Candidates: graphCandidatesForCodes(normalized, 0)}}}, nil
}

func normalizeGraphReleaseDate(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 10 {
		candidate := value[:10]
		if _, err := time.Parse("2006-01-02", candidate); err == nil {
			return candidate
		}
	}
	return ""
}

func (s *Server) executeGraphFilterWorks(ctx context.Context, userID int64, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	candidates := uniqueGraphCandidates(inputs["works"].Candidates)
	limit := configInt(node.Config, "limit", min(100, len(candidates)))
	if limit <= 0 {
		limit = len(candidates)
	}
	prefix := strings.ToUpper(configString(node.Config, "codePrefix"))
	existing := strings.ToLower(configString(node.Config, "existing"))
	if existing == "" {
		existing = "any"
	}
	accepted := []graphWorkCandidate{}
	rejected := []graphWorkCandidate{}
	for _, candidate := range candidates {
		keep := prefix == "" || strings.HasPrefix(candidate.Code, prefix)
		metadata, err := s.graphWorkFilterMetadata(ctx, userID, candidate.Code)
		if err != nil {
			return graphNodeExecution{}, err
		}
		candidate = mergeGraphCandidateMetadata(candidate, metadata)
		if keep && existing == "missing_metadata" {
			keep, err = s.graphWorkMissingMetadata(ctx, candidate.Code)
			if err != nil {
				return graphNodeExecution{}, err
			}
		} else if keep && existing != "any" {
			ref, err := s.canonicalWorkForCode(ctx, candidate.Code)
			if err != nil {
				return graphNodeExecution{}, err
			}
			keep = (existing == "known" && ref.Known) || (existing == "unknown" && !ref.Known)
		}
		if keep {
			keep = graphWorkMatchesFilter(candidate.ReleaseDate, candidate.VoiceNames, candidate.MetadataTags, metadata.UserTags, node.Config)
		}
		if keep && len(accepted) < limit {
			accepted = append(accepted, candidate)
		} else {
			candidate.Reason = "filtered"
			rejected = append(rejected, candidate)
		}
	}
	return graphNodeExecution{Outputs: map[string]graphPortValue{
		"accepted": {Type: "work_candidates", Candidates: accepted},
		"rejected": {Type: "work_candidates", Candidates: rejected},
	}}, nil
}

func (s *Server) executeGraphMetadataSync(ctx context.Context, runID int64, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	candidates := uniqueGraphCandidates(inputs["works"].Candidates)
	maxWorks := configInt(node.Config, "maxWorks", 25)
	if len(candidates) > maxWorks {
		return graphNodeExecution{}, fmt.Errorf("metadata candidate count exceeds maxWorks")
	}
	completed := []graphWorkRef{}
	failed := []graphWorkCandidate{}
	partial := false
	for _, candidate := range candidates {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return graphNodeExecution{}, err
		}
		family, err := s.syncWorkMetadataFamily(ctx, candidate.Code)
		if err != nil {
			candidate.Reason = "metadata_sync_failed"
			failed = append(failed, candidate)
			continue
		}
		var workID int64
		var code string
		if err := s.db.QueryRowContext(ctx, "SELECT id, primary_code FROM work WHERE UPPER(primary_code) = UPPER(?)", candidate.Code).Scan(&workID, &code); err != nil {
			candidate.Reason = "metadata_work_missing"
			failed = append(failed, candidate)
			continue
		}
		completed = append(completed, graphWorkRef{Code: code, WorkID: workID, SourceID: candidate.SourceID})
		partial = partial || len(family.Failures) > 0
	}
	return graphNodeExecution{Partial: partial || len(failed) > 0, Outputs: map[string]graphPortValue{
		"completed": {Type: "work_refs", WorkRefs: uniqueGraphWorkRefs(completed)},
		"failed":    {Type: "work_candidates", Candidates: uniqueGraphCandidates(failed)},
	}}, nil
}

type graphWorkFilterMetadata struct {
	ReleaseDate  string
	VoiceNames   []string
	MetadataTags []string
	UserTags     []string
}

// graphWorkMissingMetadata reports whether a catalog code still needs DLsite
// metadata: it has no work, or its work has no DLsite snapshot. A work the
// provider reported as not found is skipped so a scheduled follow does not
// request it again on every run.
func (s *Server) graphWorkMissingMetadata(ctx context.Context, code string) (bool, error) {
	var synced bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM work
			WHERE UPPER(work.primary_code) = UPPER(?)
				AND (
					EXISTS (
						SELECT 1
						FROM metadata_snapshot AS snapshot
						INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
						WHERE snapshot.work_id = work.id AND provider.code = 'dlsite'
					)
					OR EXISTS (
						SELECT 1
						FROM work_metadata_provider_state AS state
						INNER JOIN metadata_provider AS provider ON provider.id = state.provider_id
						WHERE state.work_id = work.id AND provider.code = 'dlsite' AND state.status = 'not_found'
					)
				)
		)
	`, code).Scan(&synced)
	return !synced, err
}

// graphWorkFilterMetadata reads the filterable facts of a code. A code without
// a work, or a work without a release date, falls back to the release date its
// circle or voice actor catalog recorded.
func (s *Server) graphWorkFilterMetadata(ctx context.Context, userID int64, code string) (graphWorkFilterMetadata, error) {
	metadata := graphWorkFilterMetadata{}
	var workID int64
	var release sql.NullString
	err := s.db.QueryRowContext(ctx, "SELECT id, release_date FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&workID, &release)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return metadata, err
	}
	metadata.ReleaseDate = normalizeGraphReleaseDate(release.String)
	if metadata.ReleaseDate == "" {
		var catalogRelease sql.NullString
		if err := s.db.QueryRowContext(ctx, `
			SELECT release_date FROM (
				SELECT release_date FROM party_catalog_item WHERE UPPER(primary_code) = UPPER(?) AND COALESCE(release_date, '') <> ''
				UNION ALL
				SELECT release_date FROM voice_catalog_item WHERE UPPER(primary_code) = UPPER(?) AND COALESCE(release_date, '') <> ''
			)
			LIMIT 1
		`, code, code).Scan(&catalogRelease); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return metadata, err
		}
		metadata.ReleaseDate = normalizeGraphReleaseDate(catalogRelease.String)
	}
	if workID == 0 {
		return metadata, nil
	}
	queries := []struct {
		Target *[]string
		SQL    string
		Args   []any
	}{
		{&metadata.VoiceNames, `SELECT DISTINCT person.display_name FROM work_credit INNER JOIN person ON person.id = work_credit.person_id WHERE work_credit.work_id = ? AND work_credit.role = 'voice_actor' ORDER BY person.display_name`, []any{workID}},
		{&metadata.MetadataTags, `SELECT DISTINCT tag.display_name FROM work_tag INNER JOIN tag ON tag.id = work_tag.tag_id WHERE work_tag.work_id = ? ORDER BY tag.display_name`, []any{workID}},
		{&metadata.UserTags, `SELECT DISTINCT user_tag.name FROM user_work_tag INNER JOIN user_tag ON user_tag.id = user_work_tag.user_tag_id WHERE user_work_tag.work_id = ? AND user_work_tag.user_id = ? ORDER BY user_tag.name`, []any{workID, userID}},
	}
	for _, query := range queries {
		rows, err := s.db.QueryContext(ctx, query.SQL, query.Args...)
		if err != nil {
			return metadata, err
		}
		for rows.Next() {
			var value string
			if err := rows.Scan(&value); err != nil {
				_ = rows.Close()
				return metadata, err
			}
			*query.Target = append(*query.Target, value)
		}
		if err := rows.Close(); err != nil {
			return metadata, err
		}
	}
	return metadata, nil
}

func mergeGraphCandidateMetadata(candidate graphWorkCandidate, metadata graphWorkFilterMetadata) graphWorkCandidate {
	if candidate.ReleaseDate == "" {
		candidate.ReleaseDate = metadata.ReleaseDate
	}
	candidate.VoiceNames = uniqueFoldedStrings(append(candidate.VoiceNames, metadata.VoiceNames...))
	candidate.MetadataTags = uniqueFoldedStrings(append(candidate.MetadataTags, metadata.MetadataTags...))
	return candidate
}

func graphWorkMatchesFilter(releaseDate string, voiceNames, metadataTags, userTags []string, config map[string]any) bool {
	if from := configString(config, "releaseFrom"); from != "" && (releaseDate == "" || releaseDate < from) {
		return false
	}
	if to := configString(config, "releaseTo"); to != "" && (releaseDate == "" || releaseDate > to) {
		return false
	}
	return containsAnyFold(voiceNames, configStringSlice(config, "voiceNames")) &&
		containsAnyFold(metadataTags, configStringSlice(config, "metadataTags")) &&
		containsAnyFold(userTags, configStringSlice(config, "userTags"))
}

func containsAnyFold(values, wanted []string) bool {
	if len(wanted) == 0 {
		return true
	}
	for _, target := range wanted {
		for _, value := range values {
			if strings.EqualFold(strings.TrimSpace(value), strings.TrimSpace(target)) {
				return true
			}
		}
	}
	return false
}

func uniqueFoldedStrings(values []string) []string {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if value == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}

func (s *Server) executeGraphTrackWorks(ctx context.Context, runID int64, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	candidates := uniqueGraphCandidates(inputs["works"].Candidates)
	maxWorks := configInt(node.Config, "maxWorks", 25)
	if len(candidates) > maxWorks {
		return graphNodeExecution{}, fmt.Errorf("track candidate count exceeds maxWorks")
	}
	completed := []graphWorkRef{}
	failed := []graphWorkCandidate{}
	childRunIDs := []int64{}
	for _, candidate := range candidates {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return graphNodeExecution{}, err
		}
		sourceID := candidate.SourceID
		if sourceID <= 0 {
			sourceID = configInt64(node.Config, "sourceId", 0)
		}
		if sourceID <= 0 {
			candidate.Reason = "source_required"
			failed = append(failed, candidate)
			continue
		}
		requestID := graphTrackRequestID(runID, node.ID, sourceID, candidate.Code)
		if existing, found, err := s.graphTrackRequestResult(ctx, requestID, sourceID, candidate.Code); err != nil {
			return graphNodeExecution{}, err
		} else if found {
			completed = append(completed, graphWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: sourceID, ChildRunID: existing.RunID})
			childRunIDs = append(childRunIDs, existing.RunID)
			continue
		}
		result, err := s.runRemoteWorkSync(ctx, sourceID, candidate.Code, requestID)
		if err != nil {
			candidate.Reason = "track_failed"
			failed = append(failed, candidate)
			continue
		}
		completed = append(completed, graphWorkRef{Code: result.PrimaryCode, WorkID: result.WorkID, SourceID: sourceID, ChildRunID: result.RunID})
		childRunIDs = append(childRunIDs, result.RunID)
	}
	return graphNodeExecution{Partial: len(failed) > 0, ChildRunIDs: childRunIDs, Outputs: map[string]graphPortValue{
		"completed": {Type: "work_refs", WorkRefs: completed}, "failed": {Type: "work_candidates", Candidates: failed},
	}}, nil
}

type preparedGraphFetch struct {
	Candidate graphWorkCandidate
	RequestID string
	Paths     []string
	Files     int
	Bytes     int64
	Unknown   int
}

func (s *Server) executeGraphFetchWorks(ctx context.Context, runID int64, userID int64, jobPriority int, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	candidates := uniqueGraphCandidates(inputs["works"].Candidates)
	limits := graphFetchLimitsFromConfig(node.Config)
	if len(candidates) > limits.maxWorks {
		return graphNodeExecution{}, fmt.Errorf("fetch candidate count exceeds maxWorks")
	}
	state, err := s.prepareGraphFetchCandidates(ctx, runID, node, candidates, limits)
	if err != nil {
		return graphNodeExecution{}, err
	}
	if len(state.prepared) > 1 && limits.targetTemplate != "" && !strings.Contains(limits.targetTemplate, "<work_code>") {
		return graphNodeExecution{}, fmt.Errorf("batch targetRoot must contain <work_code>")
	}
	state, err = s.enqueuePreparedGraphFetches(ctx, runID, userID, jobPriority, node, limits, state)
	if err != nil {
		return graphNodeExecution{}, err
	}
	if len(state.pendingChildren) > 0 {
		return graphNodeExecution{ChildRunIDs: state.childRunIDs, Pending: &graphPendingExecution{
			NodeID: node.ID, Kind: "fetch", Children: state.pendingChildren, Failed: state.failed,
		}}, nil
	}
	return graphNodeExecution{Partial: len(state.failed) > 0, ChildRunIDs: state.childRunIDs, Outputs: map[string]graphPortValue{
		"completed": {Type: "work_refs", WorkRefs: []graphWorkRef{}}, "failed": {Type: "work_candidates", Candidates: state.failed},
	}}, nil
}

type graphFetchLimits struct {
	maxWorks       int
	maxFiles       int
	maxBytes       int64
	allowUnknown   bool
	targetTemplate string
	minFreeBytes   int64
	excluded       map[string]bool
}

func graphFetchLimitsFromConfig(config map[string]any) graphFetchLimits {
	return graphFetchLimits{
		maxWorks: configInt(config, "maxWorks", 25), maxFiles: configInt(config, "maxFiles", 10000),
		maxBytes: configInt64(config, "maxBytes", 100*1024*1024*1024), allowUnknown: configBool(config, "allowUnknownSizes", false),
		targetTemplate: configString(config, "targetRoot"), minFreeBytes: configInt64(config, "minFreeBytes", 0),
		excluded: graphExtensionSet(configStringSlice(config, "excludeExtensions")),
	}
}

type graphFetchPreparation struct {
	prepared        []preparedGraphFetch
	failed          []graphWorkCandidate
	childRunIDs     []int64
	pendingChildren []graphPendingChild
	totalFiles      int
	totalBytes      int64
}

func (s *Server) prepareGraphFetchCandidates(ctx context.Context, runID int64, node workflowGraphNode, candidates []graphWorkCandidate, limits graphFetchLimits) (graphFetchPreparation, error) {
	state := graphFetchPreparation{}
	for _, candidate := range candidates {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return state, err
		}
		sourceID := candidate.SourceID
		if sourceID <= 0 {
			sourceID = configInt64(node.Config, "sourceId", 0)
		}
		if sourceID <= 0 {
			candidate.Reason = "source_required"
			state.failed = append(state.failed, candidate)
			continue
		}
		candidate.SourceID = sourceID
		requestID := graphFetchRequestID(runID, node.ID, candidate.Code)
		existing, found, err := s.remoteFetchRequestResult(ctx, requestID, sourceID, candidate.Code)
		if err != nil {
			return state, err
		}
		if found {
			usage, err := s.graphFetchPersistedUsage(ctx, existing.RunID)
			if err != nil {
				return state, err
			}
			if usage.Unknown > 0 && !limits.allowUnknown {
				return state, fmt.Errorf("persisted fetch plan contains unknown file sizes")
			}
			if err := state.addUsage(usage, limits); err != nil {
				return state, err
			}
			ref := graphWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: sourceID, ChildRunID: existing.RunID}
			state.pendingChildren = append(state.pendingChildren, graphPendingChild{RunID: existing.RunID, Candidate: candidate, WorkRef: ref})
			state.childRunIDs = append(state.childRunIDs, existing.RunID)
			continue
		}
		_, _, tracks, err := s.loadRemoteWorkTracksCached(ctx, sourceID, candidate.Code)
		if err != nil {
			candidate.Reason = "fetch_plan_failed"
			state.failed = append(state.failed, candidate)
			continue
		}
		item, reason, err := summarizeGraphFetch(candidate, requestID, tracks, limits)
		if err != nil {
			return state, err
		}
		if reason != "" {
			candidate.Reason = reason
			state.failed = append(state.failed, candidate)
			continue
		}
		if err := state.addUsage(graphFetchUsage{Files: item.Files, Bytes: item.Bytes, Unknown: item.Unknown}, limits); err != nil {
			return state, err
		}
		state.prepared = append(state.prepared, item)
	}
	return state, nil
}

func summarizeGraphFetch(candidate graphWorkCandidate, requestID string, tracks []kikoeru.Track, limits graphFetchLimits) (preparedGraphFetch, string, error) {
	item := preparedGraphFetch{Candidate: candidate, RequestID: requestID, Paths: []string{}}
	for _, file := range flattenRemoteSaveFiles(tracks) {
		extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(file.Path), "."))
		if limits.excluded[extension] {
			continue
		}
		item.Paths = append(item.Paths, file.Path)
		item.Files++
		if file.SizeBytes == nil || *file.SizeBytes < 0 {
			item.Unknown++
			continue
		}
		var valid bool
		item.Bytes, valid = checkedAddInt64(item.Bytes, *file.SizeBytes)
		if !valid {
			return preparedGraphFetch{}, "", fmt.Errorf("fetch size metadata exceeds supported range")
		}
	}
	if item.Files == 0 {
		return item, "no_files_after_filter", nil
	}
	if item.Unknown > 0 && !limits.allowUnknown {
		return item, "unknown_file_size", nil
	}
	return item, "", nil
}

func (state *graphFetchPreparation) addUsage(usage graphFetchUsage, limits graphFetchLimits) error {
	if usage.Files > limits.maxFiles-state.totalFiles {
		return fmt.Errorf("fetch file count exceeds maxFiles")
	}
	state.totalFiles += usage.Files
	var valid bool
	state.totalBytes, valid = checkedAddInt64(state.totalBytes, usage.Bytes)
	if !valid {
		return fmt.Errorf("fetch size metadata exceeds supported range")
	}
	if state.totalBytes > limits.maxBytes {
		return fmt.Errorf("fetch size exceeds maxBytes")
	}
	return nil
}

func (s *Server) enqueuePreparedGraphFetches(ctx context.Context, runID, userID int64, jobPriority int, node workflowGraphNode, limits graphFetchLimits, state graphFetchPreparation) (graphFetchPreparation, error) {
	for _, item := range state.prepared {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return state, err
		}
		existing, found, err := s.remoteFetchRequestResult(ctx, item.RequestID, item.Candidate.SourceID, item.Candidate.Code)
		if err != nil {
			return state, err
		}
		if found {
			ref := graphWorkRef{Code: existing.PrimaryCode, WorkID: existing.WorkID, SourceID: item.Candidate.SourceID, ChildRunID: existing.RunID}
			state.pendingChildren = append(state.pendingChildren, graphPendingChild{RunID: existing.RunID, Candidate: item.Candidate, WorkRef: ref})
			state.childRunIDs = append(state.childRunIDs, existing.RunID)
			continue
		}
		targetRoot := strings.ReplaceAll(limits.targetTemplate, "<work_code>", item.Candidate.Code)
		result, err := s.enqueueRemoteWorkSave(ctx, item.Candidate.SourceID, item.Candidate.Code, item.Paths, nil, targetRoot, item.RequestID, nil, limits.minFreeBytes, userID, jobPriority)
		if err != nil {
			item.Candidate.Reason = "fetch_queue_failed"
			state.failed = append(state.failed, item.Candidate)
			continue
		}
		ref := graphWorkRef{Code: result.PrimaryCode, WorkID: result.WorkID, SourceID: item.Candidate.SourceID, ChildRunID: result.RunID}
		state.pendingChildren = append(state.pendingChildren, graphPendingChild{RunID: result.RunID, Candidate: item.Candidate, WorkRef: ref})
		state.childRunIDs = append(state.childRunIDs, result.RunID)
	}
	return state, nil
}

func checkedAddInt64(left, right int64) (int64, bool) {
	if left < 0 || right < 0 || left > math.MaxInt64-right {
		return 0, false
	}
	return left + right, true
}

type graphFetchUsage struct {
	Files   int
	Bytes   int64
	Unknown int
}

func (s *Server) graphFetchPersistedUsage(ctx context.Context, runID int64) (graphFetchUsage, error) {
	var manifestID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id
		FROM remote_fetch_manifest
		WHERE workflow_run_id = ?
	`, runID).Scan(&manifestID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return graphFetchUsage{}, fmt.Errorf("persisted fetch request is missing its manifest")
		}
		return graphFetchUsage{}, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT expected_size_bytes
		FROM remote_fetch_manifest_item
		WHERE manifest_id = ?
		ORDER BY id
	`, manifestID)
	if err != nil {
		return graphFetchUsage{}, err
	}
	defer func() { _ = rows.Close() }()
	usage := graphFetchUsage{}
	for rows.Next() {
		var size sql.NullInt64
		if err := rows.Scan(&size); err != nil {
			return graphFetchUsage{}, err
		}
		usage.Files++
		if !size.Valid || size.Int64 < 0 {
			usage.Unknown++
			continue
		}
		var valid bool
		usage.Bytes, valid = checkedAddInt64(usage.Bytes, size.Int64)
		if !valid {
			return graphFetchUsage{}, fmt.Errorf("persisted fetch size metadata exceeds supported range")
		}
	}
	if err := rows.Err(); err != nil {
		return graphFetchUsage{}, err
	}
	if usage.Files == 0 {
		return graphFetchUsage{}, fmt.Errorf("persisted fetch manifest contains no remote files")
	}
	return usage, nil
}

func (s *Server) executeGraphTagWorks(ctx context.Context, userID int64, node workflowGraphNode, inputs map[string]graphPortValue) (graphNodeExecution, error) {
	refs := uniqueGraphWorkRefs(inputs["works"].WorkRefs)
	tagName := strings.TrimSpace(firstNonEmpty(inputs["tag"].Text, configString(node.Config, "tagName")))
	if tagName == "" || len([]rune(tagName)) > 40 {
		return graphNodeExecution{}, fmt.Errorf("tag name is required and must be at most 40 characters")
	}
	workIDs := make([]int64, 0, len(refs))
	for _, ref := range refs {
		if ref.WorkID > 0 {
			workIDs = append(workIDs, ref.WorkID)
		}
	}
	if len(workIDs) > 0 {
		if _, err := s.addWorkUserTag(ctx, userID, workIDs, tagName); err != nil {
			return graphNodeExecution{}, err
		}
	}
	return graphNodeExecution{Outputs: map[string]graphPortValue{
		"completed": {Type: "work_refs", WorkRefs: refs}, "failed": {Type: "work_refs", WorkRefs: []graphWorkRef{}},
	}}, nil
}

func uniqueGraphCandidates(values []graphWorkCandidate) []graphWorkCandidate {
	result := []graphWorkCandidate{}
	seen := map[string]bool{}
	for _, value := range values {
		value.Code = strings.ToUpper(strings.TrimSpace(value.Code))
		key := fmt.Sprintf("%d:%s", value.SourceID, value.Code)
		if value.Code == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, value)
	}
	return result
}

func uniqueGraphWorkRefs(values []graphWorkRef) []graphWorkRef {
	result := []graphWorkRef{}
	seen := map[int64]bool{}
	for _, value := range values {
		if value.WorkID <= 0 || seen[value.WorkID] {
			continue
		}
		seen[value.WorkID] = true
		result = append(result, value)
	}
	return result
}

func graphPortValuesSummary(values map[string]graphPortValue) map[string]any {
	result := map[string]any{}
	for handle, value := range values {
		summary := map[string]any{"type": value.Type}
		switch value.Type {
		case "work_candidates":
			summary["count"] = len(value.Candidates)
			codes := make([]string, 0, min(len(value.Candidates), 100))
			for index, candidate := range value.Candidates {
				if index >= 100 {
					break
				}
				codes = append(codes, candidate.Code)
			}
			summary["codes"] = codes
		case "work_refs":
			summary["count"] = len(value.WorkRefs)
			summary["works"] = value.WorkRefs
		default:
			summary["characters"] = len([]rune(value.Text))
		}
		result[handle] = summary
	}
	return result
}

func graphExtensionSet(values []string) map[string]bool {
	result := map[string]bool{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "."))
		if value != "" && len(value) <= 16 {
			result[value] = true
		}
	}
	return result
}

func graphFetchRequestID(runID int64, nodeID, code string) string {
	nodeID = regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(nodeID, "_")
	return fmt.Sprintf("cw:%d:%s:%s", runID, nodeID, strings.ToUpper(strings.TrimSpace(code)))
}

func graphTrackRequestID(runID int64, nodeID string, sourceID int64, code string) string {
	nodeID = regexp.MustCompile(`[^A-Za-z0-9._-]+`).ReplaceAllString(nodeID, "_")
	return fmt.Sprintf("cw-track:%d:%s:%d:%s", runID, nodeID, sourceID, strings.ToUpper(strings.TrimSpace(code)))
}

func (s *Server) graphTrackRequestResult(ctx context.Context, requestID string, sourceID int64, code string) (remoteWorkSyncResult, bool, error) {
	var result remoteWorkSyncResult
	err := s.db.QueryRowContext(ctx, `
		SELECT child.id,
			COALESCE(job.id, 0),
			COALESCE(CAST(json_extract(match_node.output_json, '$.work_id') AS INTEGER), 0),
			COALESCE(CAST(json_extract(child.input_json, '$.work_code') AS TEXT), '')
		FROM workflow_run AS child
		LEFT JOIN workflow_node_run AS match_node
			ON match_node.workflow_run_id = child.id AND match_node.node_id = 'match'
		LEFT JOIN workflow_job AS job ON job.workflow_run_id = child.id
		WHERE child.workflow_code = 'remote_source_sync'
			AND child.status IN ('succeeded', 'partial')
			AND child.trigger_reason = ?
			AND CAST(json_extract(child.input_json, '$.file_source_id') AS INTEGER) = ?
			AND UPPER(COALESCE(
				CAST(json_extract(child.input_json, '$.requested_work_code') AS TEXT),
				CAST(json_extract(child.input_json, '$.work_code') AS TEXT),
				''
			)) = ?
		ORDER BY child.id DESC, job.id
		LIMIT 1
	`, requestID, sourceID, strings.ToUpper(strings.TrimSpace(code))).Scan(&result.RunID, &result.JobID, &result.WorkID, &result.PrimaryCode)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkSyncResult{}, false, nil
	}
	if err != nil {
		return remoteWorkSyncResult{}, false, err
	}
	if result.RunID <= 0 || result.WorkID <= 0 || strings.TrimSpace(result.PrimaryCode) == "" {
		return remoteWorkSyncResult{}, false, fmt.Errorf("completed track request result is incomplete")
	}
	result.Status = "succeeded"
	result.Tracked = true
	result.TriggerReason = requestID
	return result, true, nil
}

func normalizeGraphWorkCodes(values []string, limit int) ([]string, error) {
	result := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		code := strings.ToUpper(strings.TrimSpace(value))
		if code == "" || seen[code] {
			continue
		}
		if !workflowGraphWorkCodePattern.MatchString(code) {
			return nil, fmt.Errorf("invalid work code: %s", code)
		}
		seen[code] = true
		result = append(result, code)
		if limit > 0 && len(result) > limit {
			return nil, fmt.Errorf("too many work codes; maximum is %d", limit)
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("at least one work code is required")
	}
	return result, nil
}

func graphCandidatesForCodes(codes []string, sourceID int64) []graphWorkCandidate {
	result := make([]graphWorkCandidate, 0, len(codes))
	for _, code := range codes {
		result = append(result, graphWorkCandidate{Code: strings.ToUpper(strings.TrimSpace(code)), SourceID: sourceID})
	}
	return result
}
