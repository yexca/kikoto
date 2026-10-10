package httpapi

// Graph output normalization and tagging helpers.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

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
