package httpapi

// Graph output normalization and tagging helpers.

import (
	"context"
	"fmt"
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
