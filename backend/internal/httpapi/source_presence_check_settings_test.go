package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
)

func (f sourcePresenceCheckFixture) presenceCheckDefinitionID(t *testing.T) int64 {
	t.Helper()
	if err := f.server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := f.db.QueryRow("SELECT id FROM workflow_definition WHERE code = ?", sourcePresenceCheckWorkflowCode).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f sourcePresenceCheckFixture) listedSources(t *testing.T) map[int64]fileSourceSummary {
	t.Helper()
	response := httptest.NewRecorder()
	f.server.listFileSources(response, fileSourceCRUDRequest(http.MethodGet, "/api/file-sources", "",
		account.User{ID: 1, Role: "admin", Permissions: []string{"sources:write"}}))
	if response.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", response.Code, response.Body.String())
	}
	var sources []fileSourceSummary
	if err := json.NewDecoder(response.Body).Decode(&sources); err != nil {
		t.Fatal(err)
	}
	byID := map[int64]fileSourceSummary{}
	for _, source := range sources {
		byID[source.ID] = source
	}
	return byID
}

func (f sourcePresenceCheckFixture) presenceCheckRuns(t *testing.T, sourceID int64) []string {
	t.Helper()
	rows, err := f.db.Query(`SELECT trigger_type || ':' || trigger_reason FROM workflow_run
		WHERE workflow_code = ? AND json_extract(input_json, '$.sourceId') = ? ORDER BY id`, sourcePresenceCheckWorkflowCode, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	runs := []string{}
	for rows.Next() {
		var run string
		if err := rows.Scan(&run); err != nil {
			t.Fatal(err)
		}
		runs = append(runs, run)
	}
	return runs
}

func TestFileSourceListShowsEachRemoteSourcesLatestCheckAndNextSchedule(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	remote := presenceRemote(t, true, "RJ00000001")
	fixture.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_local', 'Example Local', 'local', 1)`)
	fixture.addRemoteSource(t, 2, true, remote.URL)
	fixture.addRemoteSource(t, 3, true, remote.URL)
	fixture.addWork(t, 101, "RJ00000000", true)
	fixture.addWork(t, 102, "RJ00000001", true)

	queued, err := fixture.server.enqueueSourcePresenceCheck(context.Background(), sourcePresenceCheckOptions{SourceID: 2},
		workflowRunTrigger{Type: "manual", Reason: "manual"})
	if err != nil {
		t.Fatal(err)
	}
	if status, _ := fixture.runQueued(t, queued.RunID); status != "succeeded" {
		t.Fatalf("check status = %s, want succeeded", status)
	}
	definitionID := fixture.presenceCheckDefinitionID(t)
	// The sooner of two enabled schedules is the next check; a paused one and
	// another source's schedule do not count.
	for _, trigger := range []struct {
		enabled   bool
		sourceID  int64
		nextRunAt string
	}{
		{true, 2, "2026-07-15 06:00:00"},
		{true, 2, "2026-07-15 01:00:00"},
		{false, 2, "2026-07-14 00:00:00"},
		{true, 3, "2026-07-14 00:30:00"},
	} {
		fixture.exec(t, `INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json, next_run_at)
			VALUES (?, 'schedule', 'Check works', ?, '{"intervalMinutes":360}', ?, ?)`,
			definitionID, trigger.enabled, `{"sourceId":`+strconv.FormatInt(trigger.sourceID, 10)+`}`, trigger.nextRunAt)
	}

	sources := fixture.listedSources(t)
	checked := sources[2].PresenceCheck
	if checked == nil || checked.LastRun == nil || checked.LastRun.ID != queued.RunID || checked.LastRun.Status != "succeeded" ||
		checked.LastRun.CheckedWorks != 2 || checked.LastRun.AvailableWorks != 1 || checked.LastRun.At == "" {
		t.Fatalf("source 2 check = %#v, want its succeeded run with two checked and one available", checked)
	}
	if checked.NextRunAt == nil || *checked.NextRunAt != "2026-07-15 01:00:00" {
		t.Fatalf("source 2 next check = %v, want the sooner enabled schedule", checked.NextRunAt)
	}
	if never := sources[3].PresenceCheck; never == nil || never.LastRun != nil || never.NextRunAt == nil {
		t.Fatalf("source 3 check = %#v, want no run and its own schedule", never)
	}
	if sources[1].PresenceCheck != nil {
		t.Fatalf("local source check = %#v, want none", sources[1].PresenceCheck)
	}
}

func TestRemoteSourceBecomingUsableQueuesOneRecordedCheck(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	actor := account.User{ID: 1, Role: "admin", Permissions: []string{"sources:write"}}
	body := func(enabled bool, apiURL, name string) string {
		encoded, _ := json.Marshal(map[string]any{
			"displayName": name, "sourceType": sourceTypeKikoeruCompatible, "priority": 30, "enabled": enabled,
			"config": map[string]any{}, "endpoint": map[string]any{"apiUrl": apiURL, "baseUrl": apiURL},
		})
		return string(encoded)
	}
	create := httptest.NewRecorder()
	fixture.server.createFileSource(create, fileSourceCRUDRequest(http.MethodPost, "/api/file-sources",
		body(false, "https://source.example.invalid/api", "Example Remote"), actor))
	if create.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", create.Code, create.Body.String())
	}
	var created fileSourceSummary
	if err := json.NewDecoder(create.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	update := func(enabled bool, apiURL, name string) {
		t.Helper()
		id := strconv.FormatInt(created.ID, 10)
		request := fileSourceCRUDRequest(http.MethodPatch, "/api/file-sources/"+id, body(enabled, apiURL, name), actor)
		request.SetPathValue("id", id)
		response := httptest.NewRecorder()
		fixture.server.updateFileSource(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("update status = %d, body = %s", response.Code, response.Body.String())
		}
		// Let each check finish so the next change can queue its own.
		fixture.exec(t, `UPDATE workflow_run SET status = 'succeeded' WHERE workflow_code = ?`, sourcePresenceCheckWorkflowCode)
	}
	if runs := fixture.presenceCheckRuns(t, created.ID); len(runs) != 0 {
		t.Fatalf("a disabled source queued %v, want none", runs)
	}
	update(true, "https://source.example.invalid/api", "Example Remote")
	update(true, "https://source.example.invalid/api", "Example Remote Renamed")
	update(true, "https://other.example.invalid/api", "Example Remote Renamed")
	want := []string{"source_change:source_enabled", "source_change:source_endpoint_changed"}
	if runs := fixture.presenceCheckRuns(t, created.ID); !slices.Equal(runs, want) {
		t.Fatalf("source change checks = %v, want %v (a rename asks nothing)", runs, want)
	}
}

func TestDeletingRemoteSourceRemovesItsScheduledChecks(t *testing.T) {
	fixture := newSourcePresenceCheckFixture(t)
	remote := presenceRemote(t, true)
	fixture.addRemoteSource(t, 2, true, remote.URL)
	fixture.addRemoteSource(t, 3, true, remote.URL)
	definitionID := fixture.presenceCheckDefinitionID(t)
	for _, sourceID := range []int64{2, 3} {
		fixture.exec(t, `INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
			VALUES (?, 'startup', 'Check works', 1, '{}', ?)`, definitionID, `{"sourceId":`+strconv.FormatInt(sourceID, 10)+`}`)
	}
	request := fileSourceCRUDRequest(http.MethodDelete, "/api/file-sources/2", "",
		account.User{ID: 1, Role: "admin", Permissions: []string{"sources:write"}})
	request.SetPathValue("id", "2")
	response := httptest.NewRecorder()
	fixture.server.deleteFileSource(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", response.Code, response.Body.String())
	}
	var remaining []int64
	rows, err := fixture.db.Query(`SELECT json_extract(config_json, '$.sourceId') FROM workflow_trigger WHERE workflow_definition_id = ? ORDER BY id`, definitionID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var sourceID int64
		if err := rows.Scan(&sourceID); err != nil {
			t.Fatal(err)
		}
		remaining = append(remaining, sourceID)
	}
	if len(remaining) != 1 || remaining[0] != 3 {
		t.Fatalf("checks left = %v, want only the other source's", remaining)
	}
}
