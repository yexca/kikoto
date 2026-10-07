package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metasync"
)

// purchaseBonusAutoLinkSetting lets metadata sync detect a purchase bonus's
// parent product. It defaults to on.
const purchaseBonusAutoLinkSetting = "metadata_purchase_bonus_auto_link"

// workPurchaseBonus describes the parent product a purchase bonus belongs to.
// The parent is a family by code: ParentWork is set only while a work in the
// library carries that code or edition alias.
type workPurchaseBonus struct {
	Status     string                 `json:"status"`
	ParentCode string                 `json:"parentCode,omitempty"`
	Origin     string                 `json:"origin"`
	Evidence   string                 `json:"evidence,omitempty"`
	URL        string                 `json:"url,omitempty"`
	ParentWork *workPurchaseBonusWork `json:"parentWork,omitempty"`
	UpdatedAt  string                 `json:"updatedAt"`
}

type workPurchaseBonusWork struct {
	ID    int64  `json:"id"`
	Code  string `json:"code"`
	Title string `json:"title"`
}

type workPurchaseBonusResponse struct {
	PurchaseBonus *workPurchaseBonus         `json:"purchaseBonus"`
	Sync          *workMetadataSyncRunResult `json:"sync,omitempty"`
}

func (s *Server) setWorkPurchaseBonus(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	var payload struct {
		ParentCode string `json:"parentCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json body"})
		return
	}
	parentCode := normalizeDLsiteCode(payload.ParentCode)
	if parentCode == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return
	}
	var primaryCode string
	if err := s.db.QueryRowContext(r.Context(), "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&primaryCode); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	if strings.EqualFold(strings.TrimSpace(primaryCode), parentCode) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a work cannot be a purchase bonus for its own code"})
		return
	}
	if err := s.saveUserPurchaseBonus(r.Context(), workID, metasync.PurchaseBonusLinked, parentCode, user.ID); err != nil {
		writeError(w, err)
		return
	}
	s.writePurchaseBonusChange(w, r, workID, userHasPermission(user, "metadata:sync"))
}

// deleteWorkPurchaseBonus removes a bonus link and stops detection for the
// work. The next sync stores the bonus's own metadata without the parent's.
func (s *Server) deleteWorkPurchaseBonus(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.workIDExists(r.Context(), workID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	if err := s.saveUserPurchaseBonus(r.Context(), workID, metasync.PurchaseBonusDismissed, "", user.ID); err != nil {
		writeError(w, err)
		return
	}
	s.writePurchaseBonusChange(w, r, workID, userHasPermission(user, "metadata:sync"))
}

func (s *Server) saveUserPurchaseBonus(ctx context.Context, workID int64, status string, parentCode string, userID int64) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO work_purchase_bonus (work_id, provider_id, parent_code, status, origin, evidence, updated_by_user_id)
		SELECT ?, id, ?, ?, 'user', '', ? FROM metadata_provider WHERE code = 'dlsite'
		ON CONFLICT(work_id) DO UPDATE SET
			provider_id = excluded.provider_id,
			parent_code = excluded.parent_code,
			status = excluded.status,
			origin = 'user',
			evidence = '',
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = CURRENT_TIMESTAMP
	`, workID, parentCode, status, nullableUserID(userID))
	return err
}

// writePurchaseBonusChange answers a link change and, when permitted, queues
// the work's sync so inherited metadata follows the change.
func (s *Server) writePurchaseBonusChange(w http.ResponseWriter, r *http.Request, workID int64, canSync bool) {
	bonus, err := s.loadWorkPurchaseBonus(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}
	response := workPurchaseBonusResponse{PurchaseBonus: bonus}
	if canSync {
		result, err := s.enqueueWorkMetadataSyncWithOptions(r.Context(), workID, false)
		if err != nil {
			writeError(w, err)
			return
		}
		response.Sync = &result
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) loadWorkPurchaseBonus(ctx context.Context, workID int64) (*workPurchaseBonus, error) {
	var bonus workPurchaseBonus
	err := s.db.QueryRowContext(ctx, `SELECT bonus.status, bonus.parent_code, bonus.origin, bonus.evidence, bonus.updated_at
		FROM work_purchase_bonus AS bonus
		JOIN metadata_provider AS provider ON provider.id = bonus.provider_id
		WHERE bonus.work_id = ? AND provider.code = 'dlsite'`, workID).
		Scan(&bonus.Status, &bonus.ParentCode, &bonus.Origin, &bonus.Evidence, &bonus.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if bonus.ParentCode == "" {
		return &bonus, nil
	}
	bonus.URL = s.dlsiteURL(bonus.ParentCode)
	parent, err := s.loadPurchaseBonusParentWork(ctx, bonus.ParentCode)
	if err != nil {
		return nil, err
	}
	bonus.ParentWork = parent
	return &bonus, nil
}

// loadPurchaseBonusParentWork finds the library work for a parent code: the
// work with that code, otherwise the canonical work of the family declaring it.
func (s *Server) loadPurchaseBonusParentWork(ctx context.Context, parentCode string) (*workPurchaseBonusWork, error) {
	var parent workPurchaseBonusWork
	err := s.db.QueryRowContext(ctx, `SELECT work.id, work.primary_code, COALESCE(work.title, '')
		FROM work
		WHERE work.id = COALESCE(
			(SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)),
			(SELECT logical.canonical_work_id
				FROM work_code_alias AS alias
				JOIN logical_work AS logical ON logical.id = alias.logical_work_id
				WHERE UPPER(alias.primary_code) = UPPER(?)
				LIMIT 1)
		)`, parentCode, parentCode).Scan(&parent.ID, &parent.Code, &parent.Title)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &parent, nil
}

// loadWorkPurchaseBonuses lists the linked bonuses whose parent code belongs
// to the work's family.
func (s *Server) loadWorkPurchaseBonuses(ctx context.Context, workID int64) ([]workPurchaseBonusWork, error) {
	rows, err := s.db.QueryContext(ctx, `
		WITH family_code(code) AS (
			SELECT UPPER(primary_code) FROM work WHERE id = ?
			UNION
			SELECT UPPER(alias.primary_code)
			FROM work_edition AS edition
			JOIN work_code_alias AS alias ON alias.logical_work_id = edition.logical_work_id
			WHERE edition.work_id = ?
		)
		SELECT bonus_work.id, bonus_work.primary_code, COALESCE(bonus_work.title, '')
		FROM work_purchase_bonus AS bonus
		JOIN work AS bonus_work ON bonus_work.id = bonus.work_id
		WHERE bonus.status = 'linked'
			AND UPPER(bonus.parent_code) IN (SELECT code FROM family_code)
			AND bonus.work_id <> ?
		ORDER BY bonus_work.primary_code
	`, workID, workID, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	bonuses := []workPurchaseBonusWork{}
	for rows.Next() {
		var bonus workPurchaseBonusWork
		if err := rows.Scan(&bonus.ID, &bonus.Code, &bonus.Title); err != nil {
			return nil, err
		}
		bonuses = append(bonuses, bonus)
	}
	return bonuses, rows.Err()
}
