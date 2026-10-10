package httpapi

// Candidate filtering and metadata matching graph nodes.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

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
