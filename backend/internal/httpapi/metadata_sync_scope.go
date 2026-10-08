package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metasync"
)

// Metadata sync maintains works that already exist. A scope narrows the run to
// every work, the works of one circle, or the works of one voice actor; it never
// reads a catalog to add works. Discovering new works belongs to the follow
// presets.

const (
	metadataSyncScopeAll    = "all"
	metadataSyncScopeCircle = "circle"
	metadataSyncScopeVoice  = "voice"
	metadataSyncScopeWorks  = "works"
	metadataSyncModeMissing = "missing"
	metadataSyncModeFull    = "full"
)

// metadataSyncOptions is the public run and trigger input of metadata sync. The
// zero value is every work with missing or stale metadata.
type metadataSyncOptions struct {
	Scope                  string                         `json:"scope,omitempty"`
	CircleID               string                         `json:"circleId,omitempty"`
	PersonID               int64                          `json:"personId,omitempty"`
	Mode                   string                         `json:"mode,omitempty"`
	WorkCodes              []string                       `json:"workCodes,omitempty"`
	SourceID               int64                          `json:"sourceId,omitempty"`
	RemoteMetadataFallback remoteMetadataFallbackSettings `json:"remoteMetadataFallback"`
	PurchaseBonusAutoLink  *bool                          `json:"purchaseBonusAutoLink,omitempty"`
}

func (options metadataSyncOptions) normalized() (metadataSyncOptions, error) {
	options.Scope = strings.ToLower(strings.TrimSpace(options.Scope))
	options.Mode = strings.ToLower(strings.TrimSpace(options.Mode))
	if options.Scope == "" {
		options.Scope = metadataSyncScopeAll
	}
	if options.Mode == "" {
		options.Mode = metadataSyncModeMissing
	}
	if options.Mode != metadataSyncModeMissing && options.Mode != metadataSyncModeFull {
		return metadataSyncOptions{}, fmt.Errorf("mode must be missing or full")
	}
	if options.SourceID < 0 {
		return metadataSyncOptions{}, fmt.Errorf("metadata source is unavailable")
	}
	if options.Scope == metadataSyncScopeCircle && options.SourceID != 0 {
		return metadataSyncOptions{}, fmt.Errorf("circle metadata sync requires DLsite")
	}
	if options.Scope == metadataSyncScopeVoice && options.SourceID == 0 {
		return metadataSyncOptions{}, fmt.Errorf("voice actor metadata sync requires a remote metadata source")
	}
	if options.SourceID != 0 {
		options.RemoteMetadataFallback = remoteMetadataFallbackSettings{}
		options.PurchaseBonusAutoLink = nil
	} else {
		if options.PurchaseBonusAutoLink == nil {
			value := true
			options.PurchaseBonusAutoLink = &value
		}
		fallback := &options.RemoteMetadataFallback
		if !fallback.Enabled {
			fallback.SourceIDs = nil
		} else {
			if len(fallback.SourceIDs) == 0 || len(fallback.SourceIDs) > 16 {
				return metadataSyncOptions{}, fmt.Errorf("fallback must select 1 to 16 metadata sources")
			}
			seen := map[int64]bool{}
			for _, id := range fallback.SourceIDs {
				if id <= 0 || seen[id] {
					return metadataSyncOptions{}, fmt.Errorf("fallback sources must be distinct positive ids")
				}
				seen[id] = true
			}
		}
	}
	if options.Scope != metadataSyncScopeWorks {
		options.WorkCodes = nil
	}
	switch options.Scope {
	case metadataSyncScopeAll:
		options.CircleID, options.PersonID = "", 0
	case metadataSyncScopeCircle:
		options.CircleID = normalizeMakerID(options.CircleID)
		if !dlsiteMakerIDPattern.MatchString(options.CircleID) {
			return metadataSyncOptions{}, fmt.Errorf("circleId must be a DLsite circle id such as RG12345")
		}
		options.PersonID = 0
	case metadataSyncScopeVoice:
		if options.PersonID <= 0 {
			return metadataSyncOptions{}, fmt.Errorf("personId must be a voice actor id")
		}
		options.CircleID = ""
	case metadataSyncScopeWorks:
		options.CircleID, options.PersonID = "", 0
		if len(options.WorkCodes) == 0 || len(options.WorkCodes) > 100 {
			return metadataSyncOptions{}, fmt.Errorf("workCodes must contain 1 to 100 existing work codes")
		}
		codes := make([]string, 0, len(options.WorkCodes))
		for _, code := range options.WorkCodes {
			code = strings.ToUpper(strings.TrimSpace(code))
			if !workflowGraphWorkCodePattern.MatchString(code) {
				return metadataSyncOptions{}, fmt.Errorf("workCodes contains an invalid work code")
			}
			codes = append(codes, code)
		}
		slices.Sort(codes)
		options.WorkCodes = slices.Compact(codes)
	default:
		return metadataSyncOptions{}, fmt.Errorf("scope must be all, circle, voice, or works")
	}
	return options, nil
}

// validateMetadataSyncOptions normalizes options and checks that a voice actor
// target exists. A circle target may have no works yet.
func (s *Server) validateMetadataSyncOptions(ctx context.Context, options metadataSyncOptions) (metadataSyncOptions, error) {
	options, err := options.normalized()
	if err != nil {
		return metadataSyncOptions{}, err
	}
	if options.Scope == metadataSyncScopeVoice {
		if _, err := s.loadPersonName(ctx, options.PersonID); errors.Is(err, sql.ErrNoRows) {
			return metadataSyncOptions{}, fmt.Errorf("voice actor not found")
		} else if err != nil {
			return metadataSyncOptions{}, err
		}
	}
	if options.Scope == metadataSyncScopeWorks {
		for _, code := range options.WorkCodes {
			var exists bool
			if err := s.db.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM work WHERE UPPER(primary_code) = ?)", code).Scan(&exists); err != nil {
				return metadataSyncOptions{}, err
			}
			if !exists {
				return metadataSyncOptions{}, fmt.Errorf("workCodes contains a work not in the library: %s", code)
			}
		}
	}
	ids := options.RemoteMetadataFallback.SourceIDs
	if options.SourceID > 0 {
		ids = []int64{options.SourceID}
	}
	for _, id := range ids {
		if _, err := s.loadMetadataRefreshSource(ctx, id); err != nil {
			return metadataSyncOptions{}, errMetadataSourceUnavailable
		}
	}
	return options, nil
}

// metadataSyncScope resolves options to the existing works a run synchronizes.
// A circle or voice actor scope covers works credited to it and works of its
// stored catalog that already exist.
func (s *Server) metadataSyncScope(ctx context.Context, options metadataSyncOptions) (metasync.DLsiteSyncScope, error) {
	scope := metasync.DLsiteSyncScope{Full: options.Mode == metadataSyncModeFull, RecheckUnavailable: options.Scope == metadataSyncScopeWorks && options.Mode == metadataSyncModeFull || options.RemoteMetadataFallback.Enabled}
	var query string
	var args []any
	switch options.Scope {
	case metadataSyncScopeWorks:
		query = "SELECT id FROM work WHERE UPPER(primary_code) IN (" + strings.TrimSuffix(strings.Repeat("?,", len(options.WorkCodes)), ",") + ") ORDER BY id"
		for _, code := range options.WorkCodes {
			args = append(args, code)
		}
	case metadataSyncScopeCircle:
		query = `
			SELECT relation.work_id
			FROM work_party AS relation
			INNER JOIN party_external_id AS external ON external.party_id = relation.party_id
			INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
			WHERE provider.code = 'dlsite' AND external.id_type = 'maker_id' AND external.external_id = ?
				AND relation.role IN ('circle', 'translator_circle', 'official_translation_brand')
			UNION
			SELECT work.id
			FROM party_catalog_item AS catalog
			INNER JOIN party_external_id AS external ON external.party_id = catalog.party_id
			INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
			INNER JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
			WHERE provider.code = 'dlsite' AND external.id_type = 'maker_id' AND external.external_id = ?
		`
		args = []any{options.CircleID, options.CircleID}
	case metadataSyncScopeVoice:
		query = `
			SELECT work_id FROM work_credit WHERE person_id = ? AND role = 'voice_actor'
			UNION
			SELECT work.id
			FROM voice_catalog_item AS item
			INNER JOIN work ON work.id = item.work_id OR UPPER(work.primary_code) = UPPER(item.primary_code)
			WHERE item.person_id = ?
		`
		args = []any{options.PersonID, options.PersonID}
	default:
		return scope, nil
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return scope, err
	}
	defer func() { _ = rows.Close() }()
	scope.WorkIDs = []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return scope, err
		}
		scope.WorkIDs = append(scope.WorkIDs, id)
	}
	return scope, rows.Err()
}
