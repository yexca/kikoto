package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

func (s *Server) loadWorkMetadataTags(ctx context.Context, workID int64) (workMetadataTags, error) {
	var result workMetadataTags
	var err error
	result.Tags, err = metadatatags.Read(ctx, s.db, workID)
	if err != nil {
		return result, err
	}
	result.Overrides, err = metadatatags.Overrides(ctx, s.db, workID)
	if err != nil {
		return result, err
	}
	sourceID := workID
	legacy := []string{}
	selected, ok, err := metasync.SelectDLsiteMetadataVariant(ctx, s.db, workID, s.preferredMetadataLanguages(ctx))
	if err != nil {
		return result, err
	}
	var canonical bool
	err = s.db.QueryRowContext(ctx, "SELECT is_canonical FROM work_edition WHERE work_id=?", workID).Scan(&canonical)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if ok && !canonical {
		variants, err := metasync.ListDLsiteMetadataVariants(ctx, s.db, workID)
		if err != nil {
			return result, err
		}
		ok = false
		for _, v := range variants {
			if v.WorkID == workID {
				selected = v
				ok = true
				break
			}
		}
	}
	if ok {
		sourceID = selected.WorkID
		if err := json.Unmarshal([]byte(selected.TagsJSON), &legacy); err != nil {
			return result, err
		}
	}
	result.InheritedTags, err = metadatatags.Inherited(ctx, s.db, sourceID, legacy)
	return result, err
}
