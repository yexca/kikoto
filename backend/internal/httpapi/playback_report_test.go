package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/personal"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestPlaybackReportPreservesLegacySaveAgainstOfflineReplay(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	for _, statement := range []string{
		`INSERT INTO user_account (id,username,role) VALUES (1,'synthetic-listener','user')`,
		`INSERT INTO work (id,primary_code,title) VALUES (1,'` + testfixture.WorkCode(testfixture.PrefixRJ, 0) + `','Example Work')`,
		`INSERT INTO media_item (id,work_id,kind,title,fingerprint) VALUES (1,1,'audio','Example Track','synthetic-track')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	user := account.User{ID: 1, Permissions: []string{"playback:use"}}
	checkpoint := personal.ProgressInput{ReportID: "synthetic-checkpoint", Order: time.Now().Add(-time.Minute).UnixMilli(), MediaItemID: 1, PositionSeconds: 120}
	send := func() personal.PlaybackResult {
		t.Helper()
		body, err := json.Marshal(personal.PlaybackReport{Progress: []personal.ProgressInput{checkpoint}})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/playback-reports", strings.NewReader(string(body)))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
		response := httptest.NewRecorder()
		server.recordPlaybackReport(response, request)
		var result personal.PlaybackResult
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("report response = %d %s: %v", response.Code, response.Body.String(), err)
		}
		return result
	}
	if result := send(); result.Progress[0].Status != "recorded" {
		t.Fatalf("initial report = %+v", result)
	}
	if response := patchMediaProgress(t, server, user, 1, `{"positionSeconds":20}`); response.Code != http.StatusOK {
		t.Fatalf("legacy save = %d %s", response.Code, response.Body.String())
	}
	if result := send(); result.Progress[0].Status != "stale" {
		t.Fatalf("offline replay = %+v", result)
	}
	var position float64
	if err := db.QueryRow(`SELECT position_seconds FROM user_work_playback_cursor WHERE user_id=1`).Scan(&position); err != nil || position != 20 {
		t.Fatalf("legacy cursor = %v %v", position, err)
	}
	checkpoint.Order = time.Now().Add(time.Second).UnixMilli()
	checkpoint.PositionSeconds = 10
	if result := send(); result.Progress[0].Cursor == nil || result.Progress[0].Cursor.PositionSeconds != 10 {
		t.Fatalf("new backward seek = %+v", result)
	}
}

func TestPlaybackReportStrictEnvelopeAndBodyBudget(t *testing.T) {
	server := NewServer(nil, config.Config{})
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"unknown":"synthetic-secret"}`, http.StatusBadRequest},
		{`{} {}`, http.StatusBadRequest},
		{strings.Repeat(" ", 128*1024+1), http.StatusRequestEntityTooLarge},
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/playback-reports", strings.NewReader(tc.body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: 1, Permissions: []string{"playback:use"}}))
		response := httptest.NewRecorder()
		server.recordPlaybackReport(response, request)
		if response.Code != tc.want || strings.Contains(response.Body.String(), "synthetic-secret") {
			t.Fatalf("invalid body = %d %s", response.Code, response.Body.String())
		}
	}
}
