package httpapi

// Tracking and Fetch graph nodes.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

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
		result, err := s.enqueueRemoteWorkSave(withRemoteFetchOrigin(ctx, "workflow_graph"), item.Candidate.SourceID, item.Candidate.Code, item.Paths, nil, targetRoot, item.RequestID, nil, limits.minFreeBytes, userID, jobPriority)
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
