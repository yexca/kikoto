package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
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
	metadataSyncModeMissing = "missing"
	metadataSyncModeFull    = "full"
)

// metadataSyncOptions is the public run and trigger input of metadata sync. The
// zero value is every work with missing or stale metadata.
type metadataSyncOptions struct {
	Scope    string `json:"scope,omitempty"`
	CircleID string `json:"circleId,omitempty"`
	PersonID int64  `json:"personId,omitempty"`
	Mode     string `json:"mode,omitempty"`
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
	default:
		return metadataSyncOptions{}, fmt.Errorf("scope must be all, circle, or voice")
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
	return options, nil
}

// metadataSyncScope resolves options to the existing works a run synchronizes.
// A circle or voice actor scope covers works credited to it and works of its
// stored catalog that already exist.
func (s *Server) metadataSyncScope(ctx context.Context, options metadataSyncOptions) (metasync.DLsiteSyncScope, error) {
	scope := metasync.DLsiteSyncScope{Full: options.Mode == metadataSyncModeFull}
	var query string
	var args []any
	switch options.Scope {
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
