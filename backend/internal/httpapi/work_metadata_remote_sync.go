package httpapi

import (
	"context"
	"database/sql"
	"errors"

	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
)

var errMetadataSourceUnavailable = errors.New("metadata source is unavailable")

// Validate declared capability at submission and execution, without relying on
// a source's display name or exposing its endpoint in the public response.
func (s *Server) loadMetadataRefreshSource(ctx context.Context, sourceID int64) (remoteSourceForUse, error) {
	var sourceType, configJSON string
	var enabled bool
	if err := s.db.QueryRowContext(ctx, "SELECT source_type, enabled, config_json FROM file_source WHERE id = ?", sourceID).Scan(&sourceType, &enabled, &configJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, errMetadataSourceUnavailable
		}
		return remoteSourceForUse{}, err
	}
	if !enabled || !remotemetadata.SupportsMetadata(sourceType, configJSON) {
		return remoteSourceForUse{}, errMetadataSourceUnavailable
	}
	return s.loadRemoteSourceForUse(ctx, sourceID)
}

// An explicit refresh asks exactly one configured source, independently of
// DLsite availability and the automatic fallback setting. It shares the
// fallback's origin/redirect/DNS policy, paced lane, 30s deadline and 2 MiB
// response bound, but always requests a fresh description. Stored manual and
// DLsite values retain their existing precedence.
func (s *Server) executeRemoteWorkMetadataSyncJob(ctx context.Context, job workflowJobRecord, payload workMetadataSyncPayload) error {
	source, err := s.loadMetadataRefreshSource(ctx, payload.SourceID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing", map[string]any{"sourceId": source.ID}, 0, 1)
	outcome, _, refreshErr := s.requestWorkMetadataFromRemoteSource(ctx, payload.WorkID, payload.PrimaryCode, source, false)
	if err := ctx.Err(); err != nil {
		return err
	}
	providerOutcome := metasync.ProviderOutcomeSucceeded
	if outcome == remoteFallbackNotFound {
		providerOutcome = metasync.ProviderOutcomeUnavailable
	} else if refreshErr != nil || outcome != remoteFallbackFilled {
		providerOutcome = metasync.ProviderOutcomeFailed
	}
	if err := metasync.RecordProviderOutcome(ctx, s.db, payload.WorkID, remotemetadata.ProviderCode(source.Code), source.DisplayName, providerOutcome); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if refreshErr != nil || providerOutcome == metasync.ProviderOutcomeFailed {
		if refreshErr == nil {
			refreshErr = errors.New("remote metadata refresh failed")
		}
		_ = s.failClaimedWorkflowJob(ctx, job, refreshErr.Error())
		return refreshErr
	}
	status, level := "succeeded", "info"
	if outcome == remoteFallbackNotFound {
		status, level = "partial", "warn"
	}
	return s.finishWorkMetadataSyncJob(ctx, job, status, level, map[string]any{
		"work_id": payload.WorkID, "primary_code": payload.PrimaryCode,
		"source_id": source.ID, "source_code": source.Code, "outcome": outcome,
	}, 1)
}
