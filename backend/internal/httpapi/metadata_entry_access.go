package httpapi

import (
	"context"
	"database/sql"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/circleidentity"
	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

// Keep management reads aligned with the Metadata navigation. Work-editor
// completion remains available to library writers without metadata:sync.
func (s *Server) requireMetadataEntryRead(w http.ResponseWriter, r *http.Request) bool {
	user, ok := userFromContext(r.Context())
	if !ok || user.ID <= 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
		return false
	}
	if s.cfg.IsDemo() {
		return true
	}
	for _, permission := range user.Permissions {
		switch permission {
		case "library:write", "sources:write", "metadata:sync", "system:admin":
			return true
		}
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
	return false
}

func (s *Server) metadataCircleVisible(ctx context.Context, id int64) error {
	visible, err := s.circlePartyVisible(ctx, id)
	if err != nil {
		return err
	}
	if !visible {
		return sql.ErrNoRows
	}
	if s.cfg.IsDemo() {
		eligible, err := s.demoCircleEligible(ctx, id)
		if err != nil {
			return err
		}
		if !eligible {
			return sql.ErrNoRows
		}
	}
	return nil
}

func (s *Server) loadMetadataCircleForRead(ctx context.Context, id int64) (circleidentity.Circle, error) {
	result, err := circleidentity.Load(ctx, s.db, id)
	if err != nil || !s.cfg.IsDemo() {
		return result, err
	}
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT demo_work.id) FROM work AS demo_work WHERE `+contentpolicy.DemoEligibleWorkSQL("demo_work")+`
 AND (EXISTS(SELECT 1 FROM work_party WHERE work_id=demo_work.id AND party_id=? AND role='circle')
 OR EXISTS(SELECT 1 FROM `+circleCatalogProjection+` AS catalog WHERE catalog.party_id=? AND UPPER(catalog.primary_code)=UPPER(demo_work.primary_code)))`, id, id).Scan(&result.WorkCount)
	return result, err
}

func (s *Server) loadMetadataTagForRead(ctx context.Context, id int64) (metadatatags.Tag, error) {
	result, err := metadatatags.Load(ctx, s.db, id)
	if err != nil || !s.cfg.IsDemo() {
		return result, err
	}
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT link.work_id) FROM work_tag AS link JOIN work AS demo_work ON demo_work.id=link.work_id WHERE link.tag_id=? AND `+contentpolicy.DemoEligibleWorkSQL("demo_work"), id).Scan(&result.WorkCount)
	if err != nil {
		return result, err
	}
	visibleSources := []int64{}
	for _, source := range result.MergedFrom {
		var related bool
		err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM work_metadata_tag_base AS base JOIN work AS demo_work ON demo_work.id=base.work_id WHERE base.tag_id=? AND `+contentpolicy.DemoEligibleWorkSQL("demo_work")+`)
 OR EXISTS(SELECT 1 FROM work_tag_override AS overrides JOIN work AS demo_work ON demo_work.id=overrides.work_id WHERE overrides.tag_id=? AND `+contentpolicy.DemoEligibleWorkSQL("demo_work")+`)`, source, source).Scan(&related)
		if err != nil {
			return result, err
		}
		if related {
			visibleSources = append(visibleSources, source)
		}
	}
	result.MergedFrom = visibleSources
	return result, nil
}
