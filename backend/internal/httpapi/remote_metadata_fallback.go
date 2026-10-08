package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
)

// remoteMetadataFallbackTimeout bounds one source's lookup, including the
// request lane wait, the response, and its bounded body read.
const remoteMetadataFallbackTimeout = 30 * time.Second

// Fallback outcomes recorded in workflow output. Detailed errors remain in
// protected logs.
const (
	remoteFallbackDisabled = "disabled"
	remoteFallbackSkipped  = "skipped"
	remoteFallbackFilled   = "filled"
	remoteFallbackNotFound = "not_found"
	remoteFallbackFailed   = "failed"
)

type remoteMetadataFallbackAttempt struct {
	SourceCode string `json:"sourceCode"`
	Outcome    string `json:"outcome"`
	Cached     bool   `json:"cached,omitempty"`
}

type remoteMetadataFallbackResult struct {
	Status     string                          `json:"status"`
	SourceCode string                          `json:"sourceCode,omitempty"`
	Attempts   []remoteMetadataFallbackAttempt `json:"attempts"`
}

// runRemoteMetadataFallback looks up an existing work in the selected remote
// sources after DLsite explicitly reported it as not found. It runs only when
// the administrator enabled the fallback, never for a work that already has
// DLsite metadata, and stops at the first source that describes the work.
// Each source is asked once through workInfo; a matching cached catalog
// response is reused instead of a request. It never creates a work.
func (s *Server) runRemoteMetadataFallback(ctx context.Context, workID int64, code string) (remoteMetadataFallbackResult, error) {
	settings, err := remotemetadata.LoadSettings(ctx, s.db)
	if err != nil {
		return remoteMetadataFallbackResult{}, err
	}
	return s.runRemoteMetadataFallbackWithSettings(ctx, workID, code, settings)
}

// Run choices control requests only. Stored projection ordering is unchanged.
func (s *Server) runRemoteMetadataFallbackWithSettings(ctx context.Context, workID int64, code string, settings remotemetadata.Settings) (remoteMetadataFallbackResult, error) {
	result := remoteMetadataFallbackResult{Status: remoteFallbackDisabled, Attempts: []remoteMetadataFallbackAttempt{}}
	if !settings.Enabled {
		return result, nil
	}
	var hasDLsite bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (
			SELECT 1 FROM metadata_snapshot AS snapshot JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
			WHERE snapshot.work_id = ? AND provider.code = 'dlsite'
			UNION ALL SELECT 1 FROM dlsite_metadata_variant WHERE work_id = ?)`, workID, workID).Scan(&hasDLsite); err != nil {
		return result, err
	}
	if hasDLsite {
		result.Status = remoteFallbackSkipped
		return result, nil
	}
	sources, err := remotemetadata.ActiveSources(ctx, s.db, settings)
	if err != nil {
		return result, err
	}
	if len(sources) == 0 {
		return result, nil
	}
	result.Status = remoteFallbackNotFound
	failed := false
	for _, active := range sources {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		attempt := remoteMetadataFallbackAttempt{SourceCode: active.Code}
		source, err := s.loadRemoteSourceForUse(ctx, active.FileSourceID)
		if err == nil {
			attempt.Outcome, attempt.Cached, err = s.fillWorkFromRemoteSource(ctx, workID, code, source)
		} else {
			attempt.Outcome = remoteFallbackFailed
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return result, ctxErr
		}
		if err != nil {
			slog.Warn("remote metadata fallback source failed", "work_id", workID, "source_id", active.FileSourceID, "error", err)
		}
		result.Attempts = append(result.Attempts, attempt)
		status := metasync.ProviderOutcomeFailed
		switch attempt.Outcome {
		case remoteFallbackFilled:
			status = metasync.ProviderOutcomeSucceeded
		case remoteFallbackNotFound:
			status = metasync.ProviderOutcomeUnavailable
		default:
			failed = true
		}
		if err := metasync.RecordProviderOutcome(ctx, s.db, workID, active.ProviderCode, active.DisplayName, status); err != nil {
			return result, err
		}
		if attempt.Outcome == remoteFallbackFilled {
			result.Status, result.SourceCode = remoteFallbackFilled, active.Code
			// Earlier sources that lacked or failed the work no longer need
			// attention; the run output keeps their attempts.
			superseded := []string{}
			for _, earlier := range sources {
				if earlier.ProviderCode != active.ProviderCode {
					superseded = append(superseded, earlier.ProviderCode)
				}
			}
			return result, metasync.ClearWorkProviderIssues(ctx, s.db, workID, superseded)
		}
	}
	if failed {
		result.Status = remoteFallbackFailed
	}
	return result, nil
}

// fillWorkFromRemoteSource applies one source's description of the work. The
// response is untrusted: it must decode within bounds and name the same code.
func (s *Server) fillWorkFromRemoteSource(ctx context.Context, workID int64, code string, source remoteSourceForUse) (string, bool, error) {
	return s.requestWorkMetadataFromRemoteSource(ctx, workID, code, source, true)
}

// Explicit refreshes bypass stored snapshots; fallback may reuse a known description.
func (s *Server) requestWorkMetadataFromRemoteSource(ctx context.Context, workID int64, code string, source remoteSourceForUse, useCached bool) (string, bool, error) {
	var raw []byte
	var cached bool
	var err error
	if useCached {
		raw, cached, err = s.cachedRemoteWorkJSON(ctx, workID, code, source)
		if err != nil {
			return remoteFallbackFailed, false, err
		}
	}
	if raw == nil {
		requestCtx, cancel := context.WithTimeout(ctx, remoteMetadataFallbackTimeout)
		_, raw, err = s.remoteMetadataClient(requestCtx, source).WorkInfo(requestCtx, code)
		cancel()
		if err != nil {
			if kikoeru.IsNotFound(err) {
				return remoteFallbackNotFound, false, nil
			}
			return remoteFallbackFailed, false, err
		}
	}
	work, err := remotemetadata.Decode(raw)
	if err != nil {
		return remoteFallbackFailed, cached, err
	}
	if !strings.EqualFold(work.Code, code) {
		return remoteFallbackNotFound, cached, nil
	}
	var remoteWork kikoeru.Work
	if err := json.Unmarshal(raw, &remoteWork); err != nil {
		return remoteFallbackFailed, cached, err
	}
	priorities := s.instanceMetadataLanguages(ctx)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteFallbackFailed, cached, err
	}
	defer func() { _ = tx.Rollback() }()
	// Update the requested existing work only. No work, file presence or media
	// location is created by a metadata lookup, even if a work was deleted mid-request.
	providerID, err := upsertRemoteWorkMetadata(ctx, tx, source, workID, code, remoteWork, raw)
	if err != nil {
		return remoteFallbackFailed, cached, err
	}
	if err := syncVoiceCreditSnapshot(ctx, tx, voiceCreditSnapshotRow{
		WorkID: workID, ProviderID: sql.NullInt64{Int64: providerID, Valid: true}, Raw: string(raw),
	}); err != nil {
		return remoteFallbackFailed, cached, err
	}
	if _, err := remotemetadata.ReconcileWorkTx(ctx, tx, workID); err != nil {
		return remoteFallbackFailed, cached, err
	}
	// Apply shared tags now; later snapshot writes reach the durable queue.
	if err := metasync.ProjectWorkMetadataTagsTx(ctx, tx, workID, priorities); err != nil {
		return remoteFallbackFailed, cached, err
	}
	if err := tx.Commit(); err != nil {
		return remoteFallbackFailed, cached, err
	}
	if err := s.publishRemoteFallbackCover(ctx, workID, code, source, work.CoverURL); err != nil {
		slog.Warn("remote metadata fallback cover failed", "work_id", workID, "source_id", source.ID, "error", err)
	}
	return remoteFallbackFilled, cached, nil
}

// cachedRemoteWorkJSON reuses this source's stored description of the work: an
// earlier snapshot, then a voice catalog listing. Nothing is requested.
func (s *Server) cachedRemoteWorkJSON(ctx context.Context, workID int64, code string, source remoteSourceForUse) ([]byte, bool, error) {
	providerCode := remotemetadata.ProviderCode(source.Code)
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`SELECT snapshot.snapshot_json FROM metadata_snapshot AS snapshot
			JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
			WHERE snapshot.work_id = ? AND provider.code = ?
			ORDER BY snapshot.fetched_at DESC, snapshot.id DESC LIMIT 1`, []any{workID, providerCode}},
		{`SELECT catalog.raw_json FROM voice_catalog_source AS catalog
			JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
			WHERE provider.code = ? AND UPPER(catalog.remote_code) = UPPER(?) AND catalog.availability = 'available'
			ORDER BY catalog.last_seen_at DESC, catalog.id DESC LIMIT 1`, []any{providerCode, code}},
	} {
		var raw string
		err := s.db.QueryRowContext(ctx, query.sql, query.args...).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, false, err
		}
		if work, err := remotemetadata.Decode([]byte(raw)); err == nil && strings.EqualFold(work.Code, code) {
			return []byte(raw), true, nil
		}
	}
	return nil, false, nil
}

// remoteMetadataClient asks only the source's configured origins. The shared
// source transport validates and pins every connection and hop; this client
// additionally rejects a redirect to any origin the administrator did not
// configure, and buffers at most remotemetadata.MaxResponseBytes.
func (s *Server) remoteMetadataClient(ctx context.Context, source remoteSourceForUse) *kikoeru.Client {
	httpClient := s.sourceCrawlHTTPClient(source, remoteMetadataFallbackTimeout)
	configured := map[string]bool{}
	for _, candidate := range []string{source.Endpoint.APIURL, source.Endpoint.BaseURL, source.Endpoint.FallbackURL} {
		if parsed, err := outbound.ParseHTTPURL(candidate); err == nil {
			if origin, err := outbound.CanonicalOrigin(parsed); err == nil {
				configured[origin] = true
			}
		}
	}
	policyCheck := httpClient.CheckRedirect
	httpClient.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		origin, err := outbound.CanonicalOrigin(request.URL)
		if err != nil {
			return err
		}
		if !configured[origin] {
			return outbound.OriginNotAllowedError{Origin: origin}
		}
		if policyCheck != nil {
			return policyCheck(request, via)
		}
		return nil
	}
	var client *kikoeru.Client
	if source.SourceType == sourceTypeKikoeruCompatible178 {
		client = kikoeru.NewNumber178Client(source.Endpoint.APIURL, httpClient)
	} else {
		client = kikoeru.NewClient(source.Endpoint.APIURL, httpClient)
	}
	// Fallback values are stored for every user, so the instance default
	// languages decide the request, never the user who caused the refresh.
	return client.WithAcceptLanguage(s.instanceRemoteSourceAcceptLanguage(ctx, source)).WithMaxResponseBytes(remotemetadata.MaxResponseBytes)
}

// publishRemoteFallbackCover caches the source's cover only when the work has
// none; an existing DLsite or earlier cover always wins.
func (s *Server) publishRemoteFallbackCover(ctx context.Context, workID int64, code string, source remoteSourceForUse, coverURL string) error {
	if strings.TrimSpace(coverURL) == "" || strings.TrimSpace(s.cfg.CacheRoot) == "" {
		return nil
	}
	if exists, err := s.hasCachedWorkCover(code); err != nil || exists {
		return err
	}
	if err := s.downloadRemoteCover(ctx, source, code, coverURL); err != nil {
		return err
	}
	if exists, err := s.hasCachedWorkCover(code); err != nil || !exists {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var providerID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = ?", remotemetadata.ProviderCode(source.Code)).Scan(&providerID); err != nil {
		return err
	}
	if err := remotemetadata.RecordFieldTx(ctx, tx, workID, remotemetadata.FieldCover, providerID); err != nil {
		return err
	}
	return tx.Commit()
}
