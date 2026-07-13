package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

type fakeDLsiteRankingProvider struct {
	codes []string
}

func (provider fakeDLsiteRankingProvider) FetchVoiceRanking(_ context.Context, options dlsite.RankingOptions) (dlsite.RankingResult, error) {
	return dlsite.RankingResult{Period: options.Period, ReleaseWindow: options.ReleaseWindow, Year: options.Year, WorkCodes: provider.codes}, nil
}

type fakeDLsiteFamilySyncer struct {
	db *sql.DB
}

func (syncer fakeDLsiteFamilySyncer) SyncFamily(ctx context.Context, code string) (metasync.DLsiteFamilySyncResult, error) {
	if _, err := syncer.db.ExecContext(ctx, "INSERT INTO work (primary_code, work_type, title) VALUES (?, 'audio', ?) ON CONFLICT(primary_code) DO NOTHING", code, code+" title"); err != nil {
		return metasync.DLsiteFamilySyncResult{}, err
	}
	return metasync.DLsiteFamilySyncResult{RequestedCode: code, CanonicalCode: code, Codes: []string{code}, SyncedCodes: []string{code}, Failures: []string{}}, nil
}

func TestNormalizeDLsitePopularRequestUsesAnnualRules(t *testing.T) {
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	result, err := normalizeDLsitePopularRequest(dlsitePopularRunRequest{Period: "year", ReleaseWindow: "30d", Year: 2025}, now)
	if err != nil {
		t.Fatal(err)
	}
	if result.ReleaseWindow != "" || result.TagName != "260714-DL-year-2025-popular" {
		t.Fatalf("result = %+v", result)
	}
}

func TestDLsitePopularWorkflowQueuesSyncsAndTagsCurrentUser(t *testing.T) {
	db := openMigratedTestDB(t)
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('popular-user', 'Popular User', 'admin')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/dlsite-popular", strings.NewReader(`{"period":"day","releaseWindow":"30d","tagName":"260714-DL-24h-r30d-popular"}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: userID, Permissions: []string{"workflows:run", "metadata:sync", "tags:write"}}))
	response := httptest.NewRecorder()
	server.createDLsitePopularCollectionRun(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var queued dlsitePopularRunResult
	if err := json.Unmarshal(response.Body.Bytes(), &queued); err != nil {
		t.Fatal(err)
	}
	if queued.RunID <= 0 || queued.Status != "queued" {
		t.Fatalf("queued = %+v", queued)
	}
	duplicateRequest := httptest.NewRequest(http.MethodPost, "/api/workflow-runs/dlsite-popular", strings.NewReader(`{"period":"day","releaseWindow":"30d","tagName":"260714-DL-24h-r30d-popular"}`))
	duplicateRequest = duplicateRequest.WithContext(context.WithValue(duplicateRequest.Context(), currentUserKey, account.User{ID: userID, Permissions: []string{"workflows:run", "metadata:sync", "tags:write"}}))
	duplicateResponse := httptest.NewRecorder()
	server.createDLsitePopularCollectionRun(duplicateResponse, duplicateRequest)
	if duplicateResponse.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d, body = %s", duplicateResponse.Code, duplicateResponse.Body.String())
	}
	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "test-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %+v, %v, %v", job, ok, err)
	}
	if err := server.executeDLsitePopularCollectionJobWith(context.Background(), job, fakeDLsiteRankingProvider{codes: []string{"RJ01111111", "RJ02222222"}}, fakeDLsiteFamilySyncer{db: db}); err != nil {
		t.Fatal(err)
	}
	var status string
	var summary string
	if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || !strings.Contains(summary, `"tagged":2`) {
		t.Fatalf("status = %s, summary = %s", status, summary)
	}
	var assignments int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_work_tag WHERE user_id = ?", userID).Scan(&assignments); err != nil {
		t.Fatal(err)
	}
	if assignments != 2 {
		t.Fatalf("tag assignments = %d", assignments)
	}
}
