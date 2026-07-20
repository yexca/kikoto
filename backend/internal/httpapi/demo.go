package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

const demoRemoteSourceFilterQuery = "$age:general$ $-price:1$"

func (s *Server) demoWorkEligible(ctx context.Context, workID int64) (bool, error) {
	if !s.cfg.DemoMode {
		return true, nil
	}
	var primaryCode string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&primaryCode); err != nil {
		return false, err
	}
	ref, err := s.canonicalWorkForCode(ctx, primaryCode)
	if err != nil {
		return false, err
	}
	if ref.Known && ref.WorkID > 0 {
		workID = ref.WorkID
	}
	var eligible bool
	err = s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM work
			WHERE work.id = ? AND `+contentpolicy.DemoEligibleWorkSQL("work")+`
		)
	`, workID).Scan(&eligible)
	return eligible, err
}

func (s *Server) demoWorkWhere(where string, alias string) string {
	if !s.cfg.DemoMode {
		return where
	}
	return "(" + where + ") AND " + contentpolicy.DemoEligibleWorkSQL(alias)
}

func demoRemoteSourceQueryPlan(query string, sourceType string) remoteSourceQueryPlan {
	plan := planRemoteSourceQuery(query, sourceType)
	plan.PushdownQuery = strings.TrimSpace(demoRemoteSourceFilterQuery + " " + plan.PushdownQuery)
	return plan
}

func (s *Server) resolveRemoteWorkForAccess(ctx context.Context, client *kikoeru.Client, code string) (kikoeru.Work, json.RawMessage, error) {
	if !s.cfg.DemoMode {
		return s.resolveKikoeruWork(ctx, client, code)
	}
	requestedCode := strings.ToUpper(strings.TrimSpace(code))
	page, err := client.SearchWorksSortedSeeded(ctx, 1, 100, demoRemoteSourceFilterQuery+" "+requestedCode, "id", "asc", "")
	if err != nil {
		return kikoeru.Work{}, nil, err
	}
	for _, work := range page.Works {
		if !strings.EqualFold(normalizedRemoteWorkCode(work), requestedCode) {
			continue
		}
		raw, err := json.Marshal(work)
		if err != nil {
			return kikoeru.Work{}, nil, err
		}
		return work, raw, nil
	}
	return kikoeru.Work{}, nil, sql.ErrNoRows
}

func (s *Server) demoMediaLocationEligible(ctx context.Context, locationID int64) (bool, error) {
	if !s.cfg.DemoMode {
		return true, nil
	}
	var workID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT item.work_id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
	`, locationID).Scan(&workID)
	if err != nil {
		return false, err
	}
	return s.demoWorkEligible(ctx, workID)
}

func (s *Server) demoMediaItemEligible(ctx context.Context, mediaItemID int64) (bool, error) {
	if !s.cfg.DemoMode {
		return true, nil
	}
	var workID int64
	if err := s.db.QueryRowContext(ctx, "SELECT work_id FROM media_item WHERE id = ?", mediaItemID).Scan(&workID); err != nil {
		return false, err
	}
	return s.demoWorkEligible(ctx, workID)
}

func (s *Server) requireDemoWork(w http.ResponseWriter, r *http.Request, workID int64) bool {
	eligible, err := s.demoWorkEligible(r.Context(), workID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeError(w, err)
		return false
	}
	if !eligible {
		writeAPIError(w, http.StatusNotFound, "not_found", "work not found", false)
		return false
	}
	return true
}

func (s *Server) requireDemoWorkCode(w http.ResponseWriter, r *http.Request, code string) bool {
	if !s.cfg.DemoMode {
		return true
	}
	ref, err := s.canonicalWorkForCode(r.Context(), code)
	if err != nil {
		writeError(w, err)
		return false
	}
	if !ref.Known || ref.WorkID <= 0 {
		writeAPIError(w, http.StatusNotFound, "not_found", "work not found", false)
		return false
	}
	return s.requireDemoWork(w, r, ref.WorkID)
}

func (s *Server) demoWorkCodeEligible(ctx context.Context, code string) (bool, error) {
	if !s.cfg.DemoMode {
		return true, nil
	}
	ref, err := s.canonicalWorkForCode(ctx, code)
	if err != nil {
		return false, err
	}
	if !ref.Known || ref.WorkID <= 0 {
		return false, nil
	}
	return s.demoWorkEligible(ctx, ref.WorkID)
}

func (s *Server) requireDemoMediaLocation(w http.ResponseWriter, r *http.Request, locationID int64) bool {
	eligible, err := s.demoMediaLocationEligible(r.Context(), locationID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeError(w, err)
		return false
	}
	if !eligible {
		writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
		return false
	}
	return true
}

func (s *Server) demoCoverEligible(ctx context.Context, relativePath string) (bool, error) {
	if !s.cfg.DemoMode {
		return true, nil
	}
	filename := strings.TrimSpace(relativePath)
	if slash := strings.LastIndexAny(filename, `/\`); slash >= 0 {
		filename = filename[slash+1:]
	}
	if dot := strings.LastIndex(filename, "."); dot > 0 {
		filename = filename[:dot]
	}
	var workID int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", filename).Scan(&workID); err != nil {
		return false, err
	}
	return s.demoWorkEligible(ctx, workID)
}

func (s *Server) demoManualAssetEligible(ctx context.Context, filename string) (bool, error) {
	if !s.cfg.DemoMode {
		return true, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT work_id, asset_path
		FROM work_manual_override
		WHERE field_name = 'cover' AND asset_path <> ''
	`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var assetPath string
		if err := rows.Scan(&workID, &assetPath); err != nil {
			return false, err
		}
		if filepath.Base(filepath.FromSlash(assetPath)) != filename {
			continue
		}
		return s.demoWorkEligible(ctx, workID)
	}
	return false, rows.Err()
}

func (s *Server) demoContentMiddleware(next http.Handler) http.Handler {
	if !s.cfg.DemoMode {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) >= 3 && parts[0] == "api" {
			id, err := strconv.ParseInt(parts[2], 10, 64)
			if err == nil && id > 0 {
				switch parts[1] {
				case "works":
					if !s.requireDemoWork(w, r, id) {
						return
					}
				case "media-items":
					eligible, lookupErr := s.demoMediaItemEligible(r.Context(), id)
					if lookupErr != nil || !eligible {
						writeAPIError(w, http.StatusNotFound, "not_found", "media item not found", false)
						return
					}
				case "media":
					isMediaItem := len(parts) >= 4 && parts[3] == "lyrics-preference"
					if isMediaItem {
						eligible, lookupErr := s.demoMediaItemEligible(r.Context(), id)
						if lookupErr != nil || !eligible {
							writeAPIError(w, http.StatusNotFound, "not_found", "media item not found", false)
							return
						}
					} else if !s.requireDemoMediaLocation(w, r, id) {
						return
					}
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
