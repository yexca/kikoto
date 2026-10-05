package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/storage"
)

type metadataTagPage struct {
	PendingWorkCount int                `json:"pendingWorkCount"`
	Tags             []metadatatags.Tag `json:"tags"`
	Total            int                `json:"total"`
	Page             int                `json:"page"`
	PageSize         int                `json:"pageSize"`
}
type workMetadataTags struct {
	Tags          []metadatatags.EffectiveTag `json:"tags"`
	InheritedTags []metadatatags.EffectiveTag `json:"inheritedTags"`
	Overrides     []metadatatags.Override     `json:"overrides"`
}

func metadataTagError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		writeAPIError(w, http.StatusServiceUnavailable, "metadata_tag_change_timeout", "tag change timed out; retry the operation", true)
	case errors.Is(err, metadatatags.ErrHidden):
		writeAPIError(w, http.StatusConflict, "metadata_tag_hidden", "this name resolves to a hidden tag; unhide it in Metadata before adding it", false)
	case errors.Is(err, metadatatags.ErrInvalid):
		writeAPIError(w, http.StatusBadRequest, "invalid_metadata_tag", "invalid metadata tag change", false)
	case errors.Is(err, sql.ErrNoRows):
		writeAPIError(w, http.StatusNotFound, "metadata_tag_not_found", "metadata tag not found", false)
	default:
		writeError(w, err)
	}
}
func (s *Server) listMetadataTags(w http.ResponseWriter, r *http.Request) {
	if !s.requireMetadataEntryRead(w, r) {
		return
	}
	page := max(1, queryInt(r, "page", 1))
	size := max(1, min(100, queryInt(r, "pageSize", 25)))
	includeHidden := r.URL.Query().Get("includeHidden") == "true"
	if s.cfg.IsDemo() {
		includeHidden = false
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	where := `TRIM(tag.display_name)<>'' AND (? OR (concept.hidden=0 AND concept.merged_into_tag_id IS NULL)) AND (
 ?='' OR INSTR(LOWER(tag.display_name),LOWER(?))>0
 OR EXISTS(SELECT 1 FROM metadata_tag_name WHERE tag_id=tag.id AND INSTR(LOWER(name),LOWER(?))>0)
 OR EXISTS(SELECT 1 FROM dlsite_genre_name WHERE genre_id=concept.dlsite_genre_id AND INSTR(LOWER(name),LOWER(?))>0))`
	if s.cfg.IsDemo() {
		where += ` AND EXISTS(SELECT 1 FROM work_tag AS link JOIN work AS demo_work ON demo_work.id=link.work_id WHERE link.tag_id=concept.tag_id AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `)`
	}
	args := []any{includeHidden, query, query, query, query}
	result := metadataTagPage{Tags: []metadatatags.Tag{}, Page: page, PageSize: size}
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM metadata_tag AS concept INNER JOIN tag ON tag.id=concept.tag_id WHERE "+where, args...).Scan(&result.Total); err != nil {
		writeError(w, err)
		return
	}
	args = append(args, size, (page-1)*size)
	rows, err := s.db.QueryContext(r.Context(), "SELECT tag.id FROM metadata_tag AS concept INNER JOIN tag ON tag.id=concept.tag_id WHERE "+where+" ORDER BY LOWER(tag.display_name),tag.id LIMIT ? OFFSET ?", args...)
	if err != nil {
		writeError(w, err)
		return
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			writeError(w, err)
			return
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		writeError(w, err)
		return
	}
	if closeErr != nil {
		writeError(w, closeErr)
		return
	}
	for _, id := range ids {
		tag, err := s.loadMetadataTagForRead(r.Context(), id)
		if err != nil {
			writeError(w, err)
			return
		}
		result.Tags = append(result.Tags, tag)
	}
	result.PendingWorkCount, err = s.metadataTagPendingWorkCount(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) changeMetadataTag(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	var payload struct {
		Name        string            `json:"name"`
		Names       map[string]string `json:"names"`
		Hidden      *bool             `json:"hidden"`
		TargetTagID int64             `json:"targetTagId"`
	}
	if r.Method != http.MethodDelete {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			metadataTagError(w, metadatatags.ErrInvalid)
			return
		}
	}
	var id int64
	var err error
	if r.PathValue("tagId") != "" {
		id, err = parseInt64PathValue(r, "tagId")
		if err != nil {
			metadataTagError(w, metadatatags.ErrInvalid)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	priorities := s.preferredMetadataLanguages(ctx)
	tx, release, err := storage.BeginBoundedTx(ctx, s.db)
	if err != nil {
		metadataTagError(w, err)
		return
	}
	defer release()
	reproject := payload.Hidden != nil || strings.HasSuffix(r.URL.Path, "/merge")
	collect := func(tagID int64) error {
		return metadatatags.EnqueueAffectedTx(ctx, tx, tagID)
	}
	if reproject {
		for _, tagID := range []int64{id, payload.TargetTagID} {
			if err := collect(tagID); err != nil {
				metadataTagError(w, err)
				return
			}
		}
	}
	if id == 0 {
		id, err = metadatatags.CreateTx(ctx, tx, payload.Name, user.ID)
	} else {
		if strings.HasSuffix(r.URL.Path, "/merge") {
			if r.Method == http.MethodDelete {
				payload.TargetTagID = 0
			} else if payload.TargetTagID <= 0 {
				metadataTagError(w, metadatatags.ErrInvalid)
				return
			}
			err = metadatatags.MergeTx(ctx, tx, id, payload.TargetTagID)
		} else {
			if _, err = metadatatags.Load(ctx, tx, id); err == nil {
				for language, name := range payload.Names {
					if err = metadatatags.SetNameTx(ctx, tx, id, language, name, user.ID); err != nil {
						break
					}
				}
				if err == nil && payload.Hidden != nil {
					_, err = tx.ExecContext(ctx, "UPDATE metadata_tag SET hidden=?,updated_at=CURRENT_TIMESTAMP WHERE tag_id=?", *payload.Hidden, id)
				}
			}
		}
	}
	if err != nil {
		metadataTagError(w, err)
		return
	}
	if err := metadatatags.RefreshNamesTx(ctx, tx, priorities, id); err != nil {
		writeError(w, err)
		return
	}
	if reproject {
		if err := collect(id); err != nil {
			metadataTagError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		metadataTagError(w, err)
		return
	}
	release()
	tag, err := metadatatags.Load(ctx, s.db, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tag)
}
func (s *Server) getWorkMetadataTags(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		metadataTagError(w, metadatatags.ErrInvalid)
		return
	}
	if !s.workIDExists(r.Context(), id) {
		writeAPIError(w, http.StatusNotFound, "work_not_found", "work not found", false)
		return
	}
	if !s.requireDemoWork(w, r, id) {
		return
	}
	result, err := s.loadWorkMetadataTags(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) setWorkMetadataTags(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		metadataTagError(w, metadatatags.ErrInvalid)
		return
	}
	if !s.workIDExists(r.Context(), id) {
		writeAPIError(w, http.StatusNotFound, "work_not_found", "work not found", false)
		return
	}
	var payload struct {
		Overrides []metadatatags.Override `json:"overrides"`
		NewTags   []string                `json:"newTags"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		metadataTagError(w, metadatatags.ErrInvalid)
		return
	}
	priorities := s.preferredMetadataLanguages(r.Context())
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if len(payload.NewTags) > 256 {
		metadataTagError(w, metadatatags.ErrInvalid)
		return
	}
	for _, name := range payload.NewTags {
		tagID, err := metadatatags.CreateTx(r.Context(), tx, name, user.ID)
		if err != nil {
			metadataTagError(w, err)
			return
		}
		found := false
		for _, override := range payload.Overrides {
			if override.TagID == tagID {
				found = true
				break
			}
		}
		if !found {
			payload.Overrides = append(payload.Overrides, metadatatags.Override{TagID: tagID, Action: "add"})
		}
	}
	if err := metadatatags.SetOverridesTx(r.Context(), tx, id, payload.Overrides, user.ID); err != nil {
		metadataTagError(w, err)
		return
	}
	if err := metasync.ProjectWorkMetadataTagsTx(r.Context(), tx, id, priorities); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	result, err := s.loadWorkMetadataTags(r.Context(), id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
