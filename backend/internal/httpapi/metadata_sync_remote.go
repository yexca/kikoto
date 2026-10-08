package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
)

// Preserve retry classification without exposing upstream URLs or diagnostics.
type metadataSyncRequestError struct{ cause error }

func (err metadataSyncRequestError) Error() string {
	var status kikoeru.StatusError
	if errors.As(err.cause, &status) {
		return fmt.Sprintf("remote source returned HTTP %d", status.Code)
	}
	return "remote metadata refresh failed"
}

func (err metadataSyncRequestError) Unwrap() error { return err.cause }

// Remote runs share the single metadata executor and its retry budget. Every
// request uses the existing bounded, DNS-pinned metadata transport; this path
// never reads a catalog or writes file presence.
func (s *Server) syncMetadataScopeFromRemote(ctx context.Context, job workflowJobRecord, scope metasync.DLsiteSyncScope, options metadataSyncOptions) (metasync.DLsiteSyncResult, error) {
	result := metasync.DLsiteSyncResult{Status: "succeeded", Failures: []string{}, ReviewCandidates: []metasync.DLsiteReviewCandidate{}}
	source, err := s.loadMetadataRefreshSource(ctx, options.SourceID)
	if err != nil {
		return result, err
	}
	wanted := map[int64]bool{}
	for _, id := range scope.WorkIDs {
		wanted[id] = true
	}
	rows, err := s.db.QueryContext(ctx, `SELECT work.id, work.primary_code,
		EXISTS (SELECT 1 FROM metadata_snapshot snapshot JOIN metadata_provider provider ON provider.id = snapshot.provider_id
			WHERE snapshot.work_id = work.id AND provider.code = ?)
		FROM work ORDER BY work.id`, remotemetadata.ProviderCode(source.Code))
	if err != nil {
		return result, err
	}
	type target struct {
		id   int64
		code string
	}
	targets := []target{}
	for rows.Next() {
		var item target
		var described bool
		if err := rows.Scan(&item.id, &item.code, &described); err != nil {
			_ = rows.Close()
			return result, err
		}
		if scope.WorkIDs != nil && !wanted[item.id] {
			continue
		}
		if described && !scope.Full {
			result.SkippedWorks++
			continue
		}
		targets = append(targets, item)
	}
	readErr := rows.Err()
	_ = rows.Close()
	if readErr != nil {
		return result, readErr
	}
	result.TargetWorks = len(targets)
	for index, item := range targets {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		source, err = s.loadMetadataRefreshSource(ctx, options.SourceID)
		if err != nil {
			return result, errMetadataSourceUnavailable
		}
		outcome, _, requestErr := s.requestWorkMetadataFromRemoteSource(ctx, item.id, item.code, source, false)
		if err := ctx.Err(); err != nil {
			return result, err
		}
		var backoff sourceBackoffError
		if errors.As(requestErr, &backoff) {
			return result, metadataSyncRequestError{cause: requestErr}
		}
		status := metasync.ProviderOutcomeSucceeded
		switch outcome {
		case remoteFallbackFilled:
			result.SyncedWorks++
		case remoteFallbackNotFound:
			result.UnavailableWorks++
			status = metasync.ProviderOutcomeUnavailable
		default:
			status = metasync.ProviderOutcomeFailed
			result.FailedWorks++
			result.Failures = append(result.Failures, item.code+": remote metadata refresh failed")
			slog.Warn("remote metadata sync request failed", "work_id", item.id, "source_id", source.ID, "error", requestErr)
		}
		if err := metasync.RecordProviderOutcome(ctx, s.db, item.id, remotemetadata.ProviderCode(source.Code), source.DisplayName, status); err != nil {
			return result, err
		}
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing", map[string]any{"sourceId": source.ID, "sourceCode": source.Code}, index+1, len(targets))
		if requestErr != nil && isRetryableWorkflowError(requestErr) {
			return result, metadataSyncRequestError{cause: requestErr}
		}
	}
	if result.FailedWorks > 0 || result.UnavailableWorks > 0 {
		result.Status = "partial"
	}
	if result.FailedWorks > 0 && result.SyncedWorks == 0 {
		result.Status = "failed"
	}
	return result, nil
}

func (s *Server) metadataSyncFallbackHandler(job workflowJobRecord, settings remoteMetadataFallbackSettings) func(context.Context, int64, string) (bool, error) {
	return func(ctx context.Context, workID int64, code string) (bool, error) {
		fallback, err := s.runRemoteMetadataFallbackWithSettings(ctx, workID, code, remotemetadata.Settings{Enabled: settings.Enabled, SourceIDs: settings.SourceIDs})
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		if err != nil {
			slog.Warn("metadata run fallback failed", "work_id", workID, "error", err)
			fallback.Status = remoteFallbackFailed
		}
		level := "info"
		if fallback.Status == remoteFallbackFailed {
			level = "warn"
		}
		if eventErr := s.recordWorkflowRunEvent(ctx, job.RunID, level, "metadata.remote_fallback", "Metadata run used its remote fallback options", map[string]any{"work_id": workID, "code": code, "fallback": fallback}); eventErr != nil {
			return false, eventErr
		}
		if fallback.Status == remoteFallbackFailed {
			return false, errors.New("remote metadata fallback failed")
		}
		return fallback.Status == remoteFallbackFilled, nil
	}
}
