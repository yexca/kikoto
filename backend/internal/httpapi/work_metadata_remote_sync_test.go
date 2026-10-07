package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/dlsite"
)

func TestExplicitRemoteMetadataRefreshUsesFreshSnapshotWithoutTrackingFiles(t *testing.T) {
	f := newRemoteFallbackFixture(t, 60, dlsite.ErrNoProduct)
	var hits atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workInfo/"+f.code {
			t.Errorf("unexpected catalog or file request: %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		title := "Synthetic stale title"
		if hits.Add(1) > 1 {
			title = "Synthetic fresh title"
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"source_id": f.code, "title": title})
	}))
	defer remote.Close()
	sourceID := f.addSource(t, "A", 10, remote.URL)
	source, err := f.server.loadRemoteSourceForUse(context.Background(), sourceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.server.fillWorkFromRemoteSource(context.Background(), f.workID, f.code, source); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO work_metadata_provider_state(work_id,provider_id,status)
		SELECT ?,id,'not_found' FROM metadata_provider WHERE code='dlsite'`, f.workID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO work_manual_override(work_id,field_name,value_json) VALUES (?,'title','"Synthetic manual title"')`, f.workID); err != nil {
		t.Fatal(err)
	}
	// The fallback is off and DLsite already reported not found. Explicit
	// source refresh must still run, and a repeated request joins the same job.
	first, err := f.server.enqueueWorkMetadataSyncForSource(context.Background(), f.workID, false, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.server.enqueueWorkMetadataSyncForSource(context.Background(), f.workID, false, sourceID)
	if err != nil || first.RunID != second.RunID || !second.Deduplicated {
		t.Fatalf("source deduplication: first=%+v second=%+v err=%v", first, second, err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var title, manual, status, summary string
	var works, presences, locations int
	if err := f.db.QueryRow(`SELECT title,(SELECT value_json FROM work_manual_override WHERE work_id=work.id AND field_name='title'),
		(SELECT COUNT(*) FROM work),(SELECT COUNT(*) FROM work_source_presence),(SELECT COUNT(*) FROM media_file_location)
		FROM work WHERE id=?`, f.workID).Scan(&title, &manual, &works, &presences, &locations); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 2 || title != "Synthetic fresh title" || manual != `"Synthetic manual title"` || works != 1 || presences != 0 || locations != 0 {
		t.Fatalf("refresh hits=%d title=%q manual=%q works=%d presence=%d locations=%d", hits.Load(), title, manual, works, presences, locations)
	}
	if err := f.db.QueryRow("SELECT status,summary_json FROM workflow_run WHERE id=?", first.RunID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || !strings.Contains(summary, `"source_code":"example_remote_a"`) || strings.Contains(summary, remote.URL) {
		t.Fatalf("source result: status=%s summary=%s", status, summary)
	}
}

func TestExplicitRemoteMetadataRefreshPreservesDLsiteValues(t *testing.T) {
	f := newRemoteFallbackFixture(t, 61, nil)
	if _, err := f.db.Exec("UPDATE work SET title='Synthetic DLsite title' WHERE id=?", f.workID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json)
		SELECT ?,id,?,'{}' FROM metadata_provider WHERE code='dlsite'`, f.workID, f.code); err != nil {
		t.Fatal(err)
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"source_id": f.code, "title": "Synthetic remote title"})
	}))
	defer remote.Close()
	sourceID := f.addSource(t, "A", 10, remote.URL)
	if _, err := f.server.enqueueWorkMetadataSyncForSource(context.Background(), f.workID, false, sourceID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var title string
	if err := f.db.QueryRow("SELECT title FROM work WHERE id=?", f.workID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "Synthetic DLsite title" {
		t.Fatalf("remote refresh replaced DLsite title: %q", title)
	}
}

func TestExplicitRemoteMetadataRefreshValidatesPermissionAndCapability(t *testing.T) {
	f := newRemoteFallbackFixture(t, 62, nil)
	sourceID := f.addSource(t, "A", 10, "https://source.example.invalid")
	actor := account.User{ID: 1, Permissions: []string{"metadata:sync"}}
	request := func(body string, user account.User) *httptest.ResponseRecorder {
		r := fileSourceCRUDRequest(http.MethodPost, "/api/works/"+strconv.FormatInt(f.workID, 10)+"/metadata-sync", body, user)
		r.SetPathValue("id", strconv.FormatInt(f.workID, 10))
		response := httptest.NewRecorder()
		f.server.createWorkMetadataSyncRun(response, r)
		return response
	}
	body := `{"sourceId":` + strconv.FormatInt(sourceID, 10) + `}`
	if response := request(body, account.User{ID: 1}); response.Code != http.StatusForbidden {
		t.Fatalf("unprivileged refresh: %d", response.Code)
	}
	for _, invalid := range []string{`{"sourceId":0}`, `{"sourceId":-1}`, `{"sourceId":99999}`, `{"sourceId":1,"unexpected":true}`, body + ` {}`} {
		if response := request(invalid, actor); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid refresh %s: %d %s", invalid, response.Code, response.Body.String())
		}
	}
	for _, config := range []string{`{"capabilities":[]}`, `{"capabilities":["metadata"]}`} {
		if _, err := f.db.Exec("UPDATE file_source SET enabled=0, config_json=? WHERE id=?", config, sourceID); err != nil {
			t.Fatal(err)
		}
		if response := request(body, actor); response.Code != http.StatusBadRequest {
			t.Fatalf("disabled source refresh: %d", response.Code)
		}
	}
	if _, err := f.db.Exec(`UPDATE file_source SET enabled=1,config_json='{"capabilities":[]}' WHERE id=?`, sourceID); err != nil {
		t.Fatal(err)
	}
	if response := request(body, actor); response.Code != http.StatusBadRequest {
		t.Fatalf("source without metadata capability: %d", response.Code)
	}
	if _, err := f.db.Exec(`UPDATE file_source SET config_json='{}' WHERE id=?`, sourceID); err != nil {
		t.Fatal(err)
	}
	if response := request(body, actor); response.Code != http.StatusAccepted {
		t.Fatalf("metadata operator refresh: %d %s", response.Code, response.Body.String())
	}
	// Queued source jobs revalidate capability when they run.
	if _, err := f.db.Exec("UPDATE file_source SET enabled=0 WHERE id=?", sourceID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err == nil {
		t.Fatal("disabled source was allowed to execute")
	}
}
