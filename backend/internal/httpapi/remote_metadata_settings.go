package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"slices"

	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
)

// remoteMetadataFallbackSettings is the public shape of the opt-in fallback.
// SourceIDs lists selected metadata-capable remote sources in fallback order.
type remoteMetadataFallbackSettings struct {
	Enabled   bool    `json:"enabled"`
	SourceIDs []int64 `json:"sourceIds"`
}

func (s *Server) loadRemoteMetadataFallbackSettings(ctx context.Context) (remoteMetadataFallbackSettings, error) {
	settings, err := remotemetadata.LoadSettings(ctx, s.db)
	if err != nil {
		return remoteMetadataFallbackSettings{}, err
	}
	return remoteMetadataFallbackSettings{Enabled: settings.Enabled, SourceIDs: settings.SourceIDs}, nil
}

// applyRemoteMetadataFallbackSettings validates and stores the policy. When it
// changes, every work with a remote snapshot is queued for durable background
// reconciliation, so field order and shared remote tags follow the new policy,
// and pending issues of sources the fallback no longer uses are cleared.
func applyRemoteMetadataFallbackSettings(r *http.Request, tx *sql.Tx, payload *remoteMetadataFallbackSettings) error {
	if payload == nil {
		return nil
	}
	ctx := r.Context()
	if len(payload.SourceIDs) > remotemetadata.MaxSources {
		return invalidSettings("remoteMetadataFallback.sourceIds must contain at most 16 sources")
	}
	next := remotemetadata.Settings{Enabled: payload.Enabled, SourceIDs: remotemetadata.NormalizeSourceIDs(payload.SourceIDs)}
	if len(next.SourceIDs) != len(payload.SourceIDs) {
		return invalidSettings("remoteMetadataFallback.sourceIds must be distinct positive source ids")
	}
	previous, err := remotemetadata.LoadSettings(ctx, tx)
	if err != nil {
		return err
	}
	sources, err := remotemetadata.LoadSources(ctx, tx, next)
	if err != nil {
		return err
	}
	capable := map[int64]bool{}
	for _, source := range sources {
		capable[source.FileSourceID] = source.Capable
	}
	for _, id := range next.SourceIDs {
		if !capable[id] {
			return invalidSettings("remoteMetadataFallback.sourceIds must name remote sources that provide metadata")
		}
	}
	if err := upsertSetting(r, tx, remotemetadata.SettingKey, next); err != nil {
		return err
	}
	if previous.Enabled == next.Enabled && slices.Equal(previous.SourceIDs, next.SourceIDs) {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
		SELECT DISTINCT snapshot.work_id
		FROM metadata_snapshot AS snapshot
		JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
		JOIN work ON work.id = snapshot.work_id
		WHERE provider.code GLOB 'kikoeru_source_*'`); err != nil {
		return err
	}
	previousSources, err := remotemetadata.LoadSources(ctx, tx, previous)
	if err != nil {
		return err
	}
	retired := []string{}
	for _, source := range previousSources {
		if !source.Active(previous) {
			continue
		}
		stillActive := false
		for _, current := range sources {
			if current.FileSourceID == source.FileSourceID && current.Active(next) {
				stillActive = true
			}
		}
		if !stillActive {
			retired = append(retired, source.ProviderCode)
		}
	}
	return metasync.ClearProviderIssues(ctx, tx, retired)
}

// remoteSourceChangedTx re-reconciles every work one remote source described,
// so a change to its rank, enabled state or metadata capability reaches the
// works' fields and shared tags through the durable queue. Pending issues of a
// source the fallback can no longer use are cleared.
func remoteSourceChangedTx(ctx context.Context, tx *sql.Tx, sourceCode string) error {
	providerCode := remotemetadata.ProviderCode(sourceCode)
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO work_metadata_tag_dirty(work_id)
		SELECT DISTINCT snapshot.work_id
		FROM metadata_snapshot AS snapshot
		JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
		JOIN work ON work.id = snapshot.work_id
		WHERE provider.code = ?`, providerCode); err != nil {
		return err
	}
	settings, err := remotemetadata.LoadSettings(ctx, tx)
	if err != nil {
		return err
	}
	sources, err := remotemetadata.ActiveSources(ctx, tx, settings)
	if err != nil {
		return err
	}
	for _, source := range sources {
		if source.ProviderCode == providerCode {
			return nil
		}
	}
	return metasync.ClearProviderIssues(ctx, tx, []string{providerCode})
}
