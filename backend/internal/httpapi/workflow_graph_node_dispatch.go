package httpapi

// Dispatch workflow graph nodes to their typed executors.

import (
	"context"
	"fmt"
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
