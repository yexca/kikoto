package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func purchaseBonusRequest(method string, workID int64, body string, permissions ...string) *http.Request {
	request := httptest.NewRequest(method, "/api/works/"+strconv.FormatInt(workID, 10)+"/purchase-bonus", strings.NewReader(body))
	request.SetPathValue("id", strconv.FormatInt(workID, 10))
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{Permissions: permissions}))
}

func TestWorkPurchaseBonusAttachesBonusToParentFamily(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	insertWork := func(code string, title string) int64 {
		result, err := db.Exec(`INSERT INTO work (primary_code, title) VALUES (?, ?)`, code, title)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		return id
	}
	parentID := insertWork("RJ00000061", "Example Work 1")
	bonusID := insertWork("RJ00000062", "【早期購入特典】Example Voice 1")
	translationBonusID := insertWork("RJ00000064", "【早期購入特典】Example Voice 2")
	// RJ00000063 is a provider-declared edition of the parent's family.
	if _, err := db.Exec(`INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ00000061')`, parentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, is_canonical)
		SELECT ?, logical.id, provider.id, 'RJ00000061', 1 FROM logical_work AS logical, metadata_provider AS provider
		WHERE logical.canonical_code = 'RJ00000061' AND provider.code = 'dlsite'`, parentID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_code_alias (logical_work_id, provider_id, primary_code)
		SELECT logical.id, provider.id, code.value FROM logical_work AS logical, metadata_provider AS provider,
			json_each('["RJ00000061","RJ00000063"]') AS code
		WHERE logical.canonical_code = 'RJ00000061' AND provider.code = 'dlsite'`); err != nil {
		t.Fatal(err)
	}

	for _, body := range []string{`{"parentCode":"RJ00000062"}`, `{"parentCode":"not-a-code"}`, `{invalid`} {
		response := httptest.NewRecorder()
		server.setWorkPurchaseBonus(response, purchaseBonusRequest(http.MethodPut, bonusID, body, "library:write"))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d, want %d", body, response.Code, http.StatusBadRequest)
		}
	}
	forbidden := httptest.NewRecorder()
	server.setWorkPurchaseBonus(forbidden, purchaseBonusRequest(http.MethodPut, bonusID, `{"parentCode":"RJ00000061"}`, "library:read"))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("read-only status = %d, want %d", forbidden.Code, http.StatusForbidden)
	}

	for _, link := range []struct {
		id   int64
		code string
	}{{bonusID, " rj00000061 "}, {translationBonusID, "RJ00000063"}} {
		response := httptest.NewRecorder()
		server.setWorkPurchaseBonus(response, purchaseBonusRequest(http.MethodPut, link.id, `{"parentCode":"`+link.code+`"}`, "library:write", "metadata:sync"))
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body %s", response.Code, response.Body.String())
		}
		var saved workPurchaseBonusResponse
		if err := json.Unmarshal(response.Body.Bytes(), &saved); err != nil {
			t.Fatal(err)
		}
		if saved.PurchaseBonus == nil || saved.PurchaseBonus.Status != "linked" || saved.PurchaseBonus.Origin != "user" ||
			saved.PurchaseBonus.ParentWork == nil || saved.PurchaseBonus.ParentWork.ID != parentID {
			t.Fatalf("saved bonus = %+v, want the parent family's work", saved.PurchaseBonus)
		}
		if saved.Sync == nil || saved.Sync.RunID == 0 {
			t.Fatalf("sync = %+v, want a queued refresh", saved.Sync)
		}
	}

	parent, err := server.loadWorkDetail(context.Background(), 0, parentID, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(parent.PurchaseBonuses) != 2 || parent.PurchaseBonuses[0].ID != bonusID || parent.PurchaseBonuses[1].ID != translationBonusID {
		t.Fatalf("parent bonuses = %+v", parent.PurchaseBonuses)
	}
	if parent.PurchaseBonus != nil {
		t.Fatalf("parent is itself a bonus: %+v", parent.PurchaseBonus)
	}

	// Removing a link dismisses detection; the bonus leaves the family list.
	deleted := httptest.NewRecorder()
	server.deleteWorkPurchaseBonus(deleted, purchaseBonusRequest(http.MethodDelete, bonusID, "", "library:write"))
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status = %d", deleted.Code)
	}
	bonus, err := server.loadWorkDetail(context.Background(), 0, bonusID, false)
	if err != nil {
		t.Fatal(err)
	}
	if bonus.PurchaseBonus == nil || bonus.PurchaseBonus.Status != "dismissed" || bonus.PurchaseBonus.ParentCode != "" {
		t.Fatalf("dismissed bonus = %+v", bonus.PurchaseBonus)
	}
	if bonuses, err := server.loadWorkPurchaseBonuses(context.Background(), parentID); err != nil || len(bonuses) != 1 || bonuses[0].ID != translationBonusID {
		t.Fatalf("parent bonuses after dismissal = %+v, %v", bonuses, err)
	}
	var works int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work`).Scan(&works); err != nil {
		t.Fatal(err)
	}
	if works != 3 {
		t.Fatalf("works = %d, want no work created for a parent code", works)
	}
}
