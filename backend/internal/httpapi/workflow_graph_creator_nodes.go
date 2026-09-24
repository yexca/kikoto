package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// Creator nodes let the circle and voice actor follow presets refresh what a
// detail page shows: the persisted catalog, known-work metadata, and remote
// source matches. Catalog rows stay catalog rows; only the circle metadata
// refresh a user explicitly requests synchronizes catalog works.

const graphFailureCodesLimit = 20

// executeGraphVoiceCatalog optionally refreshes a voice actor's remote catalog
// and then emits the persisted catalog works seen on the selected sources.
func (s *Server) executeGraphVoiceCatalog(ctx context.Context, runID int64, node workflowGraphNode) (graphNodeExecution, error) {
	personID := int64(configInt(node.Config, "personId", 0))
	sourceIDs := configInt64Slice(node.Config, "sourceIds")
	mode := strings.ToLower(configString(node.Config, "mode"))
	summary := map[string]any{"mode": firstNonEmpty(mode, "stored")}
	partial := false
	if mode == "incremental" || mode == "full" {
		progress := voiceCatalogProgress{runID: runID}
		outcome, err := s.refreshVoiceCatalogRemote(ctx, progress, personID, sourceIDs, mode)
		if err != nil {
			return graphNodeExecution{}, err
		}
		if outcome.status == "cancelled" {
			return graphNodeExecution{}, fmt.Errorf("workflow run is cancelled")
		}
		summary["refresh_status"] = outcome.status
		summary["pages_fetched"] = outcome.pagesFetched
		summary["catalog_works"] = outcome.catalogWorks
		summary["sources"] = outcome.sourceStatuses
		// A failed source keeps its previous rows, so later steps still run on
		// the stored catalog and the run reports the refresh as partial.
		partial = outcome.status == "failed" || outcome.status == "partial"
	}
	candidates, err := s.voiceCatalogGraphCandidates(ctx, personID, sourceIDs, configInt(node.Config, "maxWorks", 100))
	if err != nil {
		return graphNodeExecution{}, err
	}
	return graphNodeExecution{
		Outputs: map[string]graphPortValue{"works": {Type: "work_candidates", Candidates: candidates}},
		Summary: summary, Partial: partial,
	}, nil
}

// voiceCatalogGraphCandidates lists persisted catalog works for one voice
// actor, newest first. With sources selected, only works currently observed
// on one of them are listed.
func (s *Server) voiceCatalogGraphCandidates(ctx context.Context, personID int64, sourceIDs []int64, limit int) ([]graphWorkCandidate, error) {
	query := `
		SELECT item.primary_code, item.title, COALESCE(item.release_date, '')
		FROM voice_catalog_item AS item
		WHERE item.person_id = ?`
	args := []any{personID}
	if len(sourceIDs) > 0 {
		query += `
			AND EXISTS (
				SELECT 1
				FROM voice_catalog_source AS observation
				INNER JOIN metadata_provider AS provider ON provider.id = observation.provider_id
				INNER JOIN file_source ON provider.code = 'kikoeru_source_' || file_source.code
				WHERE observation.catalog_item_id = item.id
					AND observation.availability = 'available'
					AND file_source.id IN (` + strings.TrimSuffix(strings.Repeat("?,", len(sourceIDs)), ",") + `)
			)`
		for _, id := range sourceIDs {
			args = append(args, id)
		}
	}
	query += ` ORDER BY COALESCE(item.release_date, '') DESC, item.primary_code ASC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	candidates := []graphWorkCandidate{}
	for rows.Next() {
		var candidate graphWorkCandidate
		if err := rows.Scan(&candidate.Code, &candidate.Title, &candidate.ReleaseDate); err != nil {
			return nil, err
		}
		candidate.Code = strings.ToUpper(strings.TrimSpace(candidate.Code))
		candidate.ReleaseDate = normalizeGraphReleaseDate(candidate.ReleaseDate)
		if workflowGraphWorkCodePattern.MatchString(candidate.Code) {
			candidates = append(candidates, candidate)
		}
	}
	return candidates, rows.Err()
}

// executeGraphVoiceMetadata refreshes known-work metadata for one voice actor.
func (s *Server) executeGraphVoiceMetadata(ctx context.Context, runID int64, node workflowGraphNode) (graphNodeExecution, error) {
	personID := int64(configInt(node.Config, "personId", 0))
	result, err := s.refreshVoiceCatalogMetadata(ctx, voiceCatalogProgress{runID: runID}, personID, configString(node.Config, "mode"))
	if err != nil {
		return graphNodeExecution{}, err
	}
	return graphNodeExecution{Partial: result.Failed > 0, Summary: map[string]any{
		"targeted": result.Targeted, "synced": result.Synced, "skipped": result.Skipped, "failed": result.Failed,
	}}, nil
}

// executeGraphCircleMetadata synchronizes catalog work metadata for each
// listed circle: missing metadata only, or every catalog work.
func (s *Server) executeGraphCircleMetadata(ctx context.Context, node workflowGraphNode) (graphNodeExecution, error) {
	productMode := configString(node.Config, "productMode")
	client := s.newDLsiteClient()
	synced, skipped := 0, 0
	failedCodes := []string{}
	for _, circleID := range splitPresetWorkflowTargets(configString(node.Config, "circleId"), normalizeMakerID) {
		partyID, err := s.ensurePlaceholderCircle(ctx, circleID)
		if err != nil {
			return graphNodeExecution{}, err
		}
		profile, err := s.loadCircleProfileForRefresh(ctx, partyID, circleID)
		if err != nil {
			return graphNodeExecution{}, err
		}
		result, err := s.syncCircleProductJSON(ctx, partyID, profile.WorkCodes, productMode, client, nil)
		if err != nil {
			return graphNodeExecution{}, err
		}
		synced += result.Synced
		skipped += result.Skipped
		for _, failure := range result.Failures {
			// Failures carry upstream detail; the node output keeps only codes.
			slog.Warn("circle metadata refresh failed", "circle_id", circleID, "failure", failure)
			if code := strings.TrimSpace(strings.SplitN(failure, ":", 2)[0]); dlsiteProductCodePattern.MatchString(code) {
				failedCodes = append(failedCodes, strings.ToUpper(code))
			}
		}
	}
	failed := len(failedCodes)
	if len(failedCodes) > graphFailureCodesLimit {
		failedCodes = failedCodes[:graphFailureCodesLimit]
	}
	return graphNodeExecution{Partial: failed > 0, Summary: map[string]any{
		"product_mode": productMode, "synced": synced, "skipped": skipped, "failed": failed, "failed_codes": failedCodes,
	}}, nil
}

// executeGraphCircleSources matches each listed circle's works on the
// selected compatible remote sources.
func (s *Server) executeGraphCircleSources(ctx context.Context, node workflowGraphNode) (graphNodeExecution, error) {
	sourceIDs := configInt64Slice(node.Config, "sourceIds")
	mode := configString(node.Config, "mode")
	matched, failed := 0, 0
	for _, circleID := range splitPresetWorkflowTargets(configString(node.Config, "circleId"), normalizeMakerID) {
		partyID, err := s.ensurePlaceholderCircle(ctx, circleID)
		if err != nil {
			return graphNodeExecution{}, err
		}
		profile, err := s.loadCircleProfileForRefresh(ctx, partyID, circleID)
		if err != nil {
			return graphNodeExecution{}, err
		}
		synced, failures, err := s.syncCircleRemoteSourceCatalogs(ctx, partyID, profile.MakerName, mode, sourceIDs)
		if err != nil {
			return graphNodeExecution{}, err
		}
		matched += synced
		failed += failures
	}
	return graphNodeExecution{Partial: failed > 0, Summary: map[string]any{
		"sources": len(sourceIDs), "matched": matched, "failed_sources": failed, "mode": mode,
	}}, nil
}
