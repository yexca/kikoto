package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
)

type resolvedWorkIdentity struct {
	WorkID   int64
	Code     string
	BaseCode string
	Metadata dlsiteSnapshotMetadata
}

// Both direct-link reads use the same read-only alias/edition resolution as
// resolve GET. Provider relationships still belong to ingestion, never a read.
func (s *Server) resolveWorkCodeIdentity(ctx context.Context, code string) (resolvedWorkIdentity, error) {
	code = normalizeDLsiteCode(code)
	if code == "" {
		return resolvedWorkIdentity{}, sql.ErrNoRows
	}
	workID, primaryCode, metadata, err := s.loadWorkCodeMetadata(ctx, code)
	if errors.Is(err, sql.ErrNoRows) {
		ref, resolveErr := s.canonicalWorkForCode(ctx, code)
		if resolveErr != nil {
			return resolvedWorkIdentity{}, resolveErr
		}
		if ref.Known {
			workID, primaryCode, metadata, err = s.loadWorkCodeMetadata(ctx, ref.Code)
		}
	}
	if err != nil {
		return resolvedWorkIdentity{}, err
	}
	identity := resolvedWorkIdentity{WorkID: workID, Code: primaryCode, BaseCode: metadata.BaseCode, Metadata: metadata}
	if canonicalID, canonicalCode, err := s.loadCanonicalWorkForCode(ctx, primaryCode); err != nil {
		return resolvedWorkIdentity{}, err
	} else if canonicalID > 0 && canonicalCode != "" {
		identity.WorkID, identity.Code, identity.BaseCode = canonicalID, canonicalCode, canonicalCode
	} else if identity.BaseCode != "" {
		// Compatibility with snapshots written before the persisted family.
		if baseID, ok := s.workIDForCode(ctx, identity.BaseCode); ok {
			identity.WorkID = baseID
			identity.Code = normalizeDLsiteCode(identity.BaseCode)
		}
	}
	return identity, nil
}

var errInvalidWorkReadID = errors.New("invalid work id or code")

// Numeric GETs keep their exact edition semantics. Codes select the canonical
// identity, allowing summary and directory reads to start in one network round.
func (s *Server) workReadID(r *http.Request) (int64, error) {
	if id, err := parseInt64PathValue(r, "id"); err == nil {
		return id, nil
	}
	code := normalizeDLsiteCode(r.PathValue("id"))
	if code == "" {
		return 0, errInvalidWorkReadID
	}
	identity, err := s.resolveWorkCodeIdentity(r.Context(), code)
	return identity.WorkID, err
}

func writeWorkReadError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errInvalidWorkReadID):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
	case errors.Is(err, sql.ErrNoRows):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
	default:
		writeError(w, err)
	}
}
