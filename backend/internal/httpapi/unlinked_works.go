package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

const maxUnlinkedWorkMaintenanceBatch = 100

type unlinkedWorkMaintenanceRequest struct {
	WorkIDs []int64 `json:"workIds"`
	Confirm bool    `json:"confirm"`
}

type unlinkedWorkMaintenanceSkip struct {
	WorkID int64  `json:"workId"`
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

type unlinkedWorkSourceCheckResult struct {
	RunID   int64                         `json:"runId"`
	JobID   int64                         `json:"jobId"`
	Status  string                        `json:"status"`
	Queued  int                           `json:"queued"`
	Skipped []unlinkedWorkMaintenanceSkip `json:"skipped"`
}

type unlinkedWorkDeleteResult struct {
	DeletedFamilyCount int                           `json:"deletedFamilyCount"`
	DeletedWorkCount   int                           `json:"deletedWorkCount"`
	DeletedWorkIDs     []int64                       `json:"deletedWorkIds"`
	DeletedCodes       []string                      `json:"deletedCodes"`
	RetainedAssetFiles int                           `json:"retainedAssetFiles"`
	Skipped            []unlinkedWorkMaintenanceSkip `json:"skipped"`
}

type unlinkedWorkFamily struct {
	LogicalWorkID   int64
	CanonicalWorkID int64
	CanonicalCode   string
	WorkIDs         []int64
	Codes           []string
}

type unlinkedWorkSourceCheckPayload struct {
	RequestedByUserID int64   `json:"requestedByUserId"`
	WorkIDs           []int64 `json:"workIds"`
}

type unlinkedWorkSourceCheckCheckpoint struct {
	CompletedWorkIDs []int64 `json:"completedWorkIds"`
	Checked          int     `json:"checked"`
	Linked           int     `json:"linked"`
	StillUnlinked    int     `json:"stillUnlinked"`
	Skipped          int     `json:"skipped"`
	HealthySources   int     `json:"healthySources"`
}

type unlinkedWorkQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func (s *Server) checkUnlinkedWorkSources(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	request, ok := decodeUnlinkedWorkMaintenanceRequest(w, r)
	if !ok {
		return
	}
	workIDs, err := normalizeUnlinkedWorkIDs(request.WorkIDs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.enqueueUnlinkedWorkSourceCheck(r.Context(), actor.ID, workIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	status := http.StatusAccepted
	if result.Queued == 0 {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func (s *Server) deleteUnlinkedWorks(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	request, ok := decodeUnlinkedWorkMaintenanceRequest(w, r)
	if !ok {
		return
	}
	if !request.Confirm {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "confirmation is required"})
		return
	}
	workIDs, err := normalizeUnlinkedWorkIDs(request.WorkIDs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.deleteUnlinkedWorkFamilies(r.Context(), actor.ID, workIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func decodeUnlinkedWorkMaintenanceRequest(w http.ResponseWriter, r *http.Request) (unlinkedWorkMaintenanceRequest, bool) {
	var request unlinkedWorkMaintenanceRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return unlinkedWorkMaintenanceRequest{}, false
	}
	return request, true
}

func normalizeUnlinkedWorkIDs(values []int64) ([]int64, error) {
	unique := map[int64]bool{}
	for _, workID := range values {
		if workID <= 0 {
			return nil, fmt.Errorf("work ids must be positive")
		}
		unique[workID] = true
	}
	if len(unique) == 0 {
		return nil, fmt.Errorf("at least one work is required")
	}
	if len(unique) > maxUnlinkedWorkMaintenanceBatch {
		return nil, fmt.Errorf("at most %d works can be maintained at once", maxUnlinkedWorkMaintenanceBatch)
	}
	result := make([]int64, 0, len(unique))
	for workID := range unique {
		result = append(result, workID)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result, nil
}

func (s *Server) enqueueUnlinkedWorkSourceCheck(ctx context.Context, actorUserID int64, workIDs []int64) (unlinkedWorkSourceCheckResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	families, skipped, err := eligibleUnlinkedWorkFamilies(ctx, tx, workIDs)
	if err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	if len(families) == 0 {
		if err := tx.Commit(); err != nil {
			return unlinkedWorkSourceCheckResult{}, err
		}
		return unlinkedWorkSourceCheckResult{Status: "succeeded", Skipped: skipped}, nil
	}
	canonicalIDs := make([]int64, 0, len(families))
	codes := make([]string, 0, len(families))
	for _, family := range families {
		canonicalIDs = append(canonicalIDs, family.CanonicalWorkID)
		codes = append(codes, family.CanonicalCode)
	}
	definition := map[string]any{"nodes": []map[string]string{
		{"id": "select", "type": "select_works", "displayName": "Select unlinked works"},
		{"id": "check", "type": "check_source_availability", "displayName": "Check source availability"},
	}}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "unlinked_work_source_check", "Check unlinked work sources", "Check configured remote sources for selected database works that have no currently available source.", definition)
	if err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	input := map[string]any{"requested_by_user_id": actorUserID, "work_ids": canonicalIDs, "codes": codes}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "unlinked_work_source_check", "Check unlinked work sources", "queued", "manual", "maintenance_unlinked_works", input, map[string]any{"queued": len(families), "skipped": len(skipped)})
	if err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_works", DisplayName: "Select unlinked works", Position: 1, Status: "succeeded",
		Input: map[string]any{"work_ids": workIDs}, Output: map[string]any{"work_ids": canonicalIDs, "codes": codes, "skipped": skipped},
	}); err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	nodeRunID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "check", NodeType: "check_source_availability", DisplayName: "Check source availability", Position: 2, Status: "queued",
		Input: map[string]any{"work_ids": canonicalIDs, "codes": codes},
	})
	if err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	payload := unlinkedWorkSourceCheckPayload{RequestedByUserID: actorUserID, WorkIDs: canonicalIDs}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: nodeRunID, WorkerType: "unlinked_work_source_check", Status: "queued",
		Priority: workflow.JobPriorityUserInitiated, ResourceKey: "remote:availability", Payload: payload,
		Checkpoint: unlinkedWorkSourceCheckCheckpoint{CompletedWorkIDs: []int64{}}, Recoverable: true, MaxRetries: 3, ProgressTotal: len(canonicalIDs),
	})
	if err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
		VALUES (?, 'unlinked_works.source_check', 'workflow_run', ?, ?)
	`, actorUserID, strconv.FormatInt(runID, 10), mustJSON(map[string]any{"queued": len(canonicalIDs), "skipped": len(skipped)})); err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return unlinkedWorkSourceCheckResult{}, err
	}
	return unlinkedWorkSourceCheckResult{RunID: runID, JobID: jobID, Status: "queued", Queued: len(canonicalIDs), Skipped: skipped}, nil
}

func (s *Server) executeUnlinkedWorkSourceCheckJob(ctx context.Context, job workflowJobRecord) error {
	var payload unlinkedWorkSourceCheckPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint := unlinkedWorkSourceCheckCheckpoint{CompletedWorkIDs: []int64{}}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	healthySourceIDs, err := s.healthyRemoteSourceIDsForAvailability(ctx, 0)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	checkpoint.HealthySources = len(healthySourceIDs)
	completed := map[int64]bool{}
	for _, workID := range checkpoint.CompletedWorkIDs {
		completed[workID] = true
	}
	for _, workID := range payload.WorkIDs {
		if completed[workID] {
			continue
		}
		family, err := resolveUnlinkedWorkFamily(ctx, s.db, workID)
		if errors.Is(err, sql.ErrNoRows) {
			checkpoint.Skipped++
		} else if err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		} else if unlinked, err := isUnlinkedWorkFamily(ctx, s.db, family.WorkIDs); err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
			return err
		} else if !unlinked {
			checkpoint.Skipped++
		} else {
			response, err := s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, family.CanonicalCode, 0, healthySourceIDs, "maintenance", "unlinked_work_source_check")
			if err != nil {
				_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
				return err
			}
			checkpoint.Checked++
			linked := false
			for _, source := range response.Sources {
				linked = linked || source.Status == "available"
			}
			if linked {
				checkpoint.Linked++
			} else {
				checkpoint.StillUnlinked++
			}
		}
		completed[workID] = true
		checkpoint.CompletedWorkIDs = append(checkpoint.CompletedWorkIDs, workID)
		if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "check_sources", checkpoint, len(checkpoint.CompletedWorkIDs), len(payload.WorkIDs)); err != nil {
			return err
		}
	}
	output := map[string]any{
		"checked": checkpoint.Checked, "linked": checkpoint.Linked, "still_unlinked": checkpoint.StillUnlinked,
		"skipped": checkpoint.Skipped, "healthy_sources": checkpoint.HealthySources,
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(output), job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_job SET status = 'succeeded', progress_current = progress_total,
		locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(output), job.RunID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) deleteUnlinkedWorkFamilies(ctx context.Context, actorUserID int64, workIDs []int64) (unlinkedWorkDeleteResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return unlinkedWorkDeleteResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := s.deleteUnlinkedWorkFamiliesTx(ctx, tx, workIDs)
	if err != nil {
		return unlinkedWorkDeleteResult{}, err
	}
	if err := insertUnlinkedWorkDeleteAudit(ctx, tx, actorUserID, result, false, "unlinked_works.delete"); err != nil {
		return unlinkedWorkDeleteResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return unlinkedWorkDeleteResult{}, err
	}
	return result, nil
}

// deleteUnlinkedWorkFamiliesTx removes the database representation of eligible
// logical work families. The caller owns the transaction so a media cleanup
// workflow can commit file-state updates and the work purge atomically.
func (s *Server) deleteUnlinkedWorkFamiliesTx(ctx context.Context, tx *sql.Tx, workIDs []int64) (unlinkedWorkDeleteResult, error) {
	families, skipped, err := eligibleUnlinkedWorkFamilies(ctx, tx, workIDs)
	if err != nil {
		return unlinkedWorkDeleteResult{}, err
	}
	result := unlinkedWorkDeleteResult{DeletedWorkIDs: []int64{}, DeletedCodes: []string{}, Skipped: skipped}
	for _, family := range families {
		placeholders := sqlPlaceholders(len(family.WorkIDs))
		args := int64Args(family.WorkIDs)
		var retainedAssets int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM work_manual_override WHERE asset_path <> '' AND work_id IN ("+placeholders+")", args...).Scan(&retainedAssets); err != nil {
			return unlinkedWorkDeleteResult{}, err
		}
		result.RetainedAssetFiles += retainedAssets
		// The general snapshot FK preserves anonymous history; this command explicitly removes the selected work metadata.
		if _, err := tx.ExecContext(ctx, "DELETE FROM metadata_snapshot WHERE work_id IN ("+placeholders+")", args...); err != nil {
			return unlinkedWorkDeleteResult{}, err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM work WHERE id IN ("+placeholders+")", args...); err != nil {
			return unlinkedWorkDeleteResult{}, err
		}
		if family.LogicalWorkID > 0 {
			if _, err := tx.ExecContext(ctx, "DELETE FROM logical_work WHERE id = ?", family.LogicalWorkID); err != nil {
				return unlinkedWorkDeleteResult{}, err
			}
		}
		result.DeletedFamilyCount++
		result.DeletedWorkCount += len(family.WorkIDs)
		result.DeletedWorkIDs = append(result.DeletedWorkIDs, family.WorkIDs...)
		result.DeletedCodes = append(result.DeletedCodes, family.Codes...)
	}
	return result, nil
}

func insertUnlinkedWorkDeleteAudit(ctx context.Context, tx *sql.Tx, actorUserID int64, result unlinkedWorkDeleteResult, mediaFilesDeleted bool, action string) error {
	if strings.TrimSpace(action) == "" {
		action = "unlinked_works.delete"
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
		VALUES (?, ?, 'work_family', ?, ?)
	`, actorUserID, action, unlinkedDeleteAuditTarget(result.DeletedCodes), mustJSON(map[string]any{
		"deleted_family_count": result.DeletedFamilyCount, "deleted_work_count": result.DeletedWorkCount,
		"deleted_codes": result.DeletedCodes, "skipped": result.Skipped, "retained_asset_files": result.RetainedAssetFiles,
		"media_files_deleted": mediaFilesDeleted,
	})); err != nil {
		return err
	}
	return nil
}

func eligibleUnlinkedWorkFamilies(ctx context.Context, queryer unlinkedWorkQueryer, workIDs []int64) ([]unlinkedWorkFamily, []unlinkedWorkMaintenanceSkip, error) {
	families := []unlinkedWorkFamily{}
	skipped := []unlinkedWorkMaintenanceSkip{}
	seenFamilies := map[string]bool{}
	for _, workID := range workIDs {
		family, err := resolveUnlinkedWorkFamily(ctx, queryer, workID)
		if errors.Is(err, sql.ErrNoRows) {
			skipped = append(skipped, unlinkedWorkMaintenanceSkip{WorkID: workID, Reason: "not_found"})
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		key := fmt.Sprintf("work:%d", family.CanonicalWorkID)
		if family.LogicalWorkID > 0 {
			key = fmt.Sprintf("logical:%d", family.LogicalWorkID)
		}
		if seenFamilies[key] {
			continue
		}
		seenFamilies[key] = true
		unlinked, err := isUnlinkedWorkFamily(ctx, queryer, family.WorkIDs)
		if err != nil {
			return nil, nil, err
		}
		if !unlinked {
			skipped = append(skipped, unlinkedWorkMaintenanceSkip{WorkID: workID, Code: family.CanonicalCode, Reason: "source_available"})
			continue
		}
		families = append(families, family)
	}
	return families, skipped, nil
}

func resolveUnlinkedWorkFamily(ctx context.Context, queryer unlinkedWorkQueryer, workID int64) (unlinkedWorkFamily, error) {
	var code string
	var editionLogicalID sql.NullInt64
	if err := queryer.QueryRowContext(ctx, `
		SELECT work.primary_code, edition.logical_work_id
		FROM work
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		WHERE work.id = ?
	`, workID).Scan(&code, &editionLogicalID); err != nil {
		return unlinkedWorkFamily{}, err
	}
	logicalWorkID := int64(0)
	if editionLogicalID.Valid {
		logicalWorkID = editionLogicalID.Int64
	} else {
		_ = queryer.QueryRowContext(ctx, "SELECT id FROM logical_work WHERE canonical_work_id = ? ORDER BY id LIMIT 1", workID).Scan(&logicalWorkID)
	}
	family := unlinkedWorkFamily{LogicalWorkID: logicalWorkID, CanonicalWorkID: workID, CanonicalCode: code, WorkIDs: []int64{}, Codes: []string{}}
	if logicalWorkID <= 0 {
		family.WorkIDs = append(family.WorkIDs, workID)
		family.Codes = append(family.Codes, code)
		return family, nil
	}
	var canonicalWorkID sql.NullInt64
	var canonicalCode string
	if err := queryer.QueryRowContext(ctx, "SELECT canonical_work_id, canonical_code FROM logical_work WHERE id = ?", logicalWorkID).Scan(&canonicalWorkID, &canonicalCode); err != nil {
		return unlinkedWorkFamily{}, err
	}
	rows, err := queryer.QueryContext(ctx, `
		SELECT work.id, work.primary_code, edition.is_canonical
		FROM work_edition AS edition
		INNER JOIN work ON work.id = edition.work_id
		WHERE edition.logical_work_id = ?
		ORDER BY edition.is_canonical DESC, work.id ASC
	`, logicalWorkID)
	if err != nil {
		return unlinkedWorkFamily{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var memberID int64
		var memberCode string
		var canonical bool
		if err := rows.Scan(&memberID, &memberCode, &canonical); err != nil {
			return unlinkedWorkFamily{}, err
		}
		family.WorkIDs = append(family.WorkIDs, memberID)
		family.Codes = append(family.Codes, memberCode)
		if canonical || canonicalWorkID.Valid && canonicalWorkID.Int64 == memberID {
			family.CanonicalWorkID = memberID
			family.CanonicalCode = memberCode
		}
	}
	if err := rows.Err(); err != nil {
		return unlinkedWorkFamily{}, err
	}
	if err := rows.Close(); err != nil {
		return unlinkedWorkFamily{}, err
	}
	if len(family.WorkIDs) == 0 {
		family.WorkIDs = append(family.WorkIDs, workID)
		family.Codes = append(family.Codes, code)
	}
	if canonicalWorkID.Valid {
		family.CanonicalWorkID = canonicalWorkID.Int64
		if resolvedCode := codeForWorkID(ctx, queryer, canonicalWorkID.Int64); resolvedCode != "" {
			family.CanonicalCode = resolvedCode
		}
	} else if strings.TrimSpace(canonicalCode) != "" {
		family.CanonicalCode = canonicalCode
	}
	return family, nil
}

func codeForWorkID(ctx context.Context, queryer unlinkedWorkQueryer, workID int64) string {
	var code string
	_ = queryer.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code)
	return code
}

func isUnlinkedWorkFamily(ctx context.Context, queryer unlinkedWorkQueryer, workIDs []int64) (bool, error) {
	if len(workIDs) == 0 {
		return false, nil
	}
	placeholders := sqlPlaceholders(len(workIDs))
	args := int64Args(workIDs)
	args = append(args, int64Args(workIDs)...)
	var unlinked bool
	err := queryer.QueryRowContext(ctx, `
		SELECT
			NOT EXISTS (
				SELECT 1 FROM work_source_presence
				WHERE availability = 'available' AND work_id IN (`+placeholders+`)
			)
			AND NOT EXISTS (
				SELECT 1
				FROM media_file_location AS location
				INNER JOIN media_item AS item ON item.id = location.media_item_id
				WHERE location.availability = 'available' AND item.work_id IN (`+placeholders+`)
			)
	`, args...).Scan(&unlinked)
	return unlinked, err
}

func sqlPlaceholders(count int) string {
	return strings.TrimRight(strings.Repeat("?,", count), ",")
}

func int64Args(values []int64) []any {
	result := make([]any, 0, len(values))
	for _, value := range values {
		result = append(result, value)
	}
	return result
}

func unlinkedDeleteAuditTarget(codes []string) string {
	if len(codes) == 1 {
		return codes[0]
	}
	return fmt.Sprintf("batch:%d", len(codes))
}
