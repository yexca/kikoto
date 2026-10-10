package httpapi

// Catalog and metadata discovery graph nodes.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
)

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
