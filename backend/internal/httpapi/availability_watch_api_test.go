package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func availabilityWatchAPIRequest(method, target, body string, actor *account.User) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if actor == nil {
		return request
	}
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, *actor))
}

func TestAvailabilityWatchHandlersPersistConfigurationTargetsAndRunState(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec("INSERT INTO user_account (id, username, role) VALUES (1, 'watch-api-user', 'admin')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, api_url, base_url)
		VALUES (1, 'https://source.example.invalid/api', 'https://source.example.invalid')
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 1, Role: "admin", Permissions: account.PermissionsForRole("admin")}
	listener := account.User{ID: 2, Role: "user", Permissions: account.PermissionsForRole("user")}

	unauthorized := httptest.NewRecorder()
	server.getAvailabilityWatch(unauthorized, availabilityWatchAPIRequest(http.MethodGet, "/api/availability-watch", "", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized get status = %d, body = %s", unauthorized.Code, unauthorized.Body.String())
	}

	initial := httptest.NewRecorder()
	server.getAvailabilityWatch(initial, availabilityWatchAPIRequest(http.MethodGet, "/api/availability-watch", "", &actor))
	var initialView availabilityWatchView
	if err := json.NewDecoder(initial.Body).Decode(&initialView); err != nil {
		t.Fatal(err)
	}
	if initial.Code != http.StatusOK || initialView.ID != 0 || len(initialView.Targets) != 0 {
		t.Fatalf("initial view status = %d, view = %#v", initial.Code, initialView)
	}

	badJSON := httptest.NewRecorder()
	server.updateAvailabilityWatch(badJSON, availabilityWatchAPIRequest(http.MethodPut, "/api/availability-watch", "{", &actor))
	if badJSON.Code != http.StatusBadRequest {
		t.Fatalf("bad config JSON status = %d, body = %s", badJSON.Code, badJSON.Body.String())
	}

	// Saving the source needs metadata:sync, which a listener lacks.
	unauthorizedSave := httptest.NewRecorder()
	server.updateAvailabilityWatch(unauthorizedSave, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"sourceId":null}`,
		&listener,
	))
	if unauthorizedSave.Code != http.StatusForbidden {
		t.Fatalf("save without metadata sync status = %d, body = %s", unauthorizedSave.Code, unauthorizedSave.Body.String())
	}

	invalidSource := httptest.NewRecorder()
	server.updateAvailabilityWatch(invalidSource, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"sourceId":999}`,
		&actor,
	))
	if invalidSource.Code != http.StatusBadRequest {
		t.Fatalf("invalid source status = %d, body = %s", invalidSource.Code, invalidSource.Body.String())
	}

	// A former client's action and exclusion are ignored: the watch only monitors.
	update := httptest.NewRecorder()
	server.updateAvailabilityWatch(update, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"action":"fetch","sourceId":1,"excludeExtensions":["wav"]}`,
		&actor,
	))
	var configured availabilityWatchView
	if err := json.NewDecoder(update.Body).Decode(&configured); err != nil {
		t.Fatal(err)
	}
	if update.Code != http.StatusOK || configured.ID != availabilityWatchID || configured.SourceID == nil || *configured.SourceID != 1 {
		t.Fatalf("configured status = %d, view = %#v", update.Code, configured)
	}
	var storedAction string
	if err := db.QueryRow("SELECT action FROM availability_watch WHERE id = 1").Scan(&storedAction); err != nil {
		t.Fatal(err)
	}
	if storedAction != "monitor" {
		t.Fatalf("stored action = %q", storedAction)
	}

	badTargets := httptest.NewRecorder()
	server.updateAvailabilityWatchTargets(badTargets, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch/targets",
		`{"targetCodes":["RJ0000"]}`,
		&actor,
	))
	if badTargets.Code != http.StatusBadRequest {
		t.Fatalf("invalid target status = %d, body = %s", badTargets.Code, badTargets.Body.String())
	}

	validTargets := httptest.NewRecorder()
	server.updateAvailabilityWatchTargets(validTargets, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch/targets",
		`{"targetCodes":[" rj00000001 ","RJ00000000","RJ00000001"]}`,
		&actor,
	))
	var targetView availabilityWatchView
	if err := json.NewDecoder(validTargets.Body).Decode(&targetView); err != nil {
		t.Fatal(err)
	}
	if validTargets.Code != http.StatusOK || len(targetView.Targets) != 2 || targetView.Targets[0].WorkCode != "RJ00000000" || targetView.Targets[1].WorkCode != "RJ00000001" {
		t.Fatalf("target update status = %d, targets = %#v", validTargets.Code, targetView.Targets)
	}

	deleteInvalid := httptest.NewRecorder()
	invalidDeleteRequest := availabilityWatchAPIRequest(http.MethodDelete, "/api/availability-watch/targets/nope", "", &actor)
	invalidDeleteRequest.SetPathValue("id", "nope")
	server.deleteAvailabilityWatchTarget(deleteInvalid, invalidDeleteRequest)
	if deleteInvalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid target id status = %d, body = %s", deleteInvalid.Code, deleteInvalid.Body.String())
	}

	deleteMissing := httptest.NewRecorder()
	missingDeleteRequest := availabilityWatchAPIRequest(http.MethodDelete, "/api/availability-watch/targets/999", "", &actor)
	missingDeleteRequest.SetPathValue("id", "999")
	server.deleteAvailabilityWatchTarget(deleteMissing, missingDeleteRequest)
	if deleteMissing.Code != http.StatusNotFound {
		t.Fatalf("missing target status = %d, body = %s", deleteMissing.Code, deleteMissing.Body.String())
	}

	deleteExisting := httptest.NewRecorder()
	deleteRequest := availabilityWatchAPIRequest(http.MethodDelete, "/api/availability-watch/targets/1", "", &actor)
	deleteRequest.SetPathValue("id", "1")
	server.deleteAvailabilityWatchTarget(deleteExisting, deleteRequest)
	if deleteExisting.Code != http.StatusOK {
		t.Fatalf("delete target status = %d, body = %s", deleteExisting.Code, deleteExisting.Body.String())
	}

	queued := httptest.NewRecorder()
	server.runAvailabilityWatch(queued, availabilityWatchAPIRequest(http.MethodPost, "/api/availability-watch/run", "", &actor))
	if queued.Code != http.StatusAccepted {
		t.Fatalf("run status = %d, body = %s", queued.Code, queued.Body.String())
	}
	// The run checks the monitoring pool and has no dispatch stage.
	var queuedRun availabilityWatchRunResult
	if err := json.NewDecoder(queued.Body).Decode(&queuedRun); err != nil {
		t.Fatal(err)
	}
	var dispatchNodes int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_node_run WHERE workflow_run_id = ? AND node_id = 'dispatch'", queuedRun.RunID).Scan(&dispatchNodes); err != nil {
		t.Fatal(err)
	}
	if dispatchNodes != 0 {
		t.Fatalf("watch run has %d dispatch nodes", dispatchNodes)
	}
	conflict := httptest.NewRecorder()
	server.runAvailabilityWatch(conflict, availabilityWatchAPIRequest(http.MethodPost, "/api/availability-watch/run", "", &actor))
	if conflict.Code != http.StatusConflict {
		t.Fatalf("duplicate run status = %d, body = %s", conflict.Code, conflict.Body.String())
	}

	getAfter := httptest.NewRecorder()
	server.getAvailabilityWatch(getAfter, availabilityWatchAPIRequest(http.MethodGet, "/api/availability-watch", "", &actor))
	var finalView availabilityWatchView
	if err := json.NewDecoder(getAfter.Body).Decode(&finalView); err != nil {
		t.Fatal(err)
	}
	if getAfter.Code != http.StatusOK || finalView.ID != availabilityWatchID {
		t.Fatalf("final view status = %d, view = %#v", getAfter.Code, finalView)
	}

	var deletedActive, remainingActive int
	if err := db.QueryRow("SELECT active FROM availability_watch_target WHERE id = 1").Scan(&deletedActive); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT active FROM availability_watch_target WHERE id = 2").Scan(&remainingActive); err != nil {
		t.Fatal(err)
	}
	if deletedActive != 0 || remainingActive != 1 {
		t.Fatalf("target activity after delete = deleted:%d remaining:%d", deletedActive, remainingActive)
	}
}

func TestAvailabilityWatchCleanUpRemovesOnlyListedTargetsInLibraryOrDone(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-clean-user', 'admin')`,
		`INSERT INTO availability_watch (id, configured_by_user_id) VALUES (1, 1)`,
		`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES
			(10, 'remote_fetch', 'Fetch', 'succeeded', 'manual'), (11, 'remote_fetch', 'Fetch', 'running', 'manual')`,
		// RJ00000001 has local files; RJ00000005 has them too but is not listed.
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Local'), (5, 'RJ00000005', 'Local')`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Track'), (5, 5, 'audio', 'Track')`,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (11, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES
			(1, 11, 'local', '/library/RJ00000001/track.mp3', 'available'), (5, 11, 'local', '/library/RJ00000005/track.mp3', 'available')`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, active, state, fetch_run_id) VALUES
			(1, 1, 'RJ00000001', 1, 'ready', NULL),
			(2, 1, 'RJ00000002', 1, 'ready', 10),
			(3, 1, 'RJ00000003', 1, 'ready', 11),
			(4, 1, 'RJ00000004', 1, 'monitoring', NULL),
			(5, 1, 'RJ00000005', 1, 'ready', NULL)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 1, Role: "admin", Permissions: account.PermissionsForRole("admin")}

	view, err := server.loadAvailabilityWatch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	inLibrary := map[string]bool{}
	fetchStatus := map[string]string{}
	for _, target := range view.Targets {
		inLibrary[target.WorkCode] = target.InLibrary
		fetchStatus[target.WorkCode] = target.FetchRunStatus
	}
	if !inLibrary["RJ00000001"] || inLibrary["RJ00000002"] || !inLibrary["RJ00000005"] {
		t.Fatalf("in library = %v", inLibrary)
	}
	if fetchStatus["RJ00000002"] != "succeeded" || fetchStatus["RJ00000003"] != "running" || fetchStatus["RJ00000004"] != "" {
		t.Fatalf("fetch run status = %v", fetchStatus)
	}

	invalid := httptest.NewRecorder()
	server.cleanUpAvailabilityWatchTargets(invalid, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/targets/clean-up", `{"targetIds":[0]}`, &actor,
	))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status = %d, body = %s", invalid.Code, invalid.Body.String())
	}

	// Target 3's Fetch is still running and target 4 is waiting, so both
	// stay; target 5 was not listed, so it stays too.
	cleaned := httptest.NewRecorder()
	server.cleanUpAvailabilityWatchTargets(cleaned, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/targets/clean-up", `{"targetIds":[1,2,3,4]}`, &actor,
	))
	if cleaned.Code != http.StatusOK {
		t.Fatalf("clean up status = %d, body = %s", cleaned.Code, cleaned.Body.String())
	}
	if err := json.NewDecoder(cleaned.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	codes := make([]string, 0, len(view.Targets))
	for _, target := range view.Targets {
		codes = append(codes, target.WorkCode)
	}
	sort.Strings(codes)
	if strings.Join(codes, ",") != "RJ00000003,RJ00000004,RJ00000005" {
		t.Fatalf("remaining targets = %v", codes)
	}

	removed := httptest.NewRecorder()
	server.removeAvailabilityWatchTargets(removed, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/targets/remove", `{"targetIds":[3,4]}`, &actor,
	))
	if err := json.NewDecoder(removed.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if removed.Code != http.StatusOK || len(view.Targets) != 1 || view.Targets[0].WorkCode != "RJ00000005" {
		t.Fatalf("remove status = %d, targets = %#v", removed.Code, view.Targets)
	}
}

func TestAvailabilityWatchRequiresMetadataSyncAndActionsTheirRemotePermission(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-permission-user', 'contributor')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO availability_watch (id, configured_by_user_id) VALUES (1, 1)`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	type request struct {
		method, target, body string
		handler              http.HandlerFunc
	}
	for _, test := range []struct {
		name        string
		permissions []string
		requests    []request
	}{
		{"watch without metadata sync", []string{"workflows:run", "remote:track", "remote:fetch"}, []request{
			{http.MethodPut, "/api/availability-watch", `{"sourceId":null}`, server.updateAvailabilityWatch},
			{http.MethodPost, "/api/availability-watch/run", `{}`, server.runAvailabilityWatch},
			{http.MethodPost, "/api/availability-watch/targets", `{"targetCodes":["RJ00000001"]}`, server.addAvailabilityWatchTargets},
			{http.MethodPost, "/api/availability-watch/targets/clean-up", `{"targetIds":[1]}`, server.cleanUpAvailabilityWatchTargets},
			{http.MethodPost, "/api/availability-watch/targets/remove", `{"targetIds":[1]}`, server.removeAvailabilityWatchTargets},
		}},
		{"track without remote track", []string{"workflows:run", "metadata:sync", "remote:fetch"}, []request{
			{http.MethodPost, "/api/availability-watch/track", `{"targetIds":[1]}`, server.trackAvailabilityWatchTargets},
		}},
		{"fetch without remote fetch", []string{"workflows:run", "metadata:sync", "remote:track"}, []request{
			{http.MethodPost, "/api/availability-watch/fetch", `{"targetIds":[1]}`, server.fetchAvailabilityWatchTargets},
		}},
	} {
		actor := account.User{ID: 1, Permissions: test.permissions}
		for _, request := range test.requests {
			response := httptest.NewRecorder()
			request.handler(response, availabilityWatchAPIRequest(request.method, request.target, request.body, &actor))
			if response.Code != http.StatusForbidden {
				t.Fatalf("%s: %s %s = %d, want 403: %s", test.name, request.method, request.target, response.Code, response.Body.String())
			}
		}
	}
}

func TestAvailabilityWatchFetchQueuesAvailableTargetsThroughRemoteBulkFetch(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-fetch-user', 'admin')`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES
			(1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1),
			(2, 'other_remote', 'Other Remote', 'kikoeru_compatible', 1)`,
		`INSERT INTO availability_watch (id, configured_by_user_id) VALUES (1, 1)`,
		// RJ00000066 is available only as its edition RJ00000088.
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state, available_source_id, available_code) VALUES
			(1, 1, 'RJ00000066', 'ready', 1, 'RJ00000088'),
			(2, 1, 'RJ00000002', 'ready', 2, 'RJ00000002'),
			(3, 1, 'RJ00000003', 'monitoring', NULL, '')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 1, Role: "admin", Permissions: account.PermissionsForRole("admin")}

	tooMany := make([]string, remoteBulkMaxWorks+1)
	for index := range tooMany {
		tooMany[index] = fmt.Sprint(index + 1)
	}
	capped := httptest.NewRecorder()
	server.fetchAvailabilityWatchTargets(capped, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/fetch", `{"targetIds":[`+strings.Join(tooMany, ",")+`]}`, &actor,
	))
	if capped.Code != http.StatusBadRequest {
		t.Fatalf("over the cap status = %d, body = %s", capped.Code, capped.Body.String())
	}

	response := httptest.NewRecorder()
	server.fetchAvailabilityWatchTargets(response, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/fetch", `{"targetIds":[1,2,3],"excludeExtensions":[".WAV","flac"]}`, &actor,
	))
	if response.Code != http.StatusAccepted {
		t.Fatalf("fetch status = %d, body = %s", response.Code, response.Body.String())
	}
	var result availabilityWatchActionResult
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	// One bulk run per source; the waiting target is skipped.
	if len(result.Runs) != 2 || result.Skipped != 1 || len(result.Queued) != 2 {
		t.Fatalf("fetch result = %#v", result)
	}
	if result.Runs[0].SourceID != 1 || strings.Join(result.Runs[0].Codes, ",") != "RJ00000088" || result.Runs[0].Action != "fetch" {
		t.Fatalf("first bulk run = %#v", result.Runs[0])
	}
	var workflowCode, payloadJSON string
	var fetchRunID int64
	if err := db.QueryRow(`
		SELECT run.workflow_code, job.payload_json, target.fetch_run_id
		FROM availability_watch_target AS target
		INNER JOIN workflow_run AS run ON run.id = target.fetch_run_id
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE target.id = 1
	`).Scan(&workflowCode, &payloadJSON, &fetchRunID); err != nil {
		t.Fatal(err)
	}
	var payload remoteBulkActionJobPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if workflowCode != "remote_bulk_action" || fetchRunID != result.Runs[0].RunID ||
		strings.Join(payload.ExcludeExtensions, ",") != "flac,wav" || payload.WatchTargets["RJ00000088"] != 1 {
		t.Fatalf("target 1 run = %s #%d, payload = %#v", workflowCode, fetchRunID, payload)
	}

	// A target whose Fetch is queued is not queued again.
	again := httptest.NewRecorder()
	server.fetchAvailabilityWatchTargets(again, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/fetch", `{"targetIds":[1]}`, &actor,
	))
	if err := json.NewDecoder(again.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if again.Code != http.StatusAccepted || len(result.Runs) != 0 || result.Skipped != 1 {
		t.Fatalf("repeated fetch status = %d, result = %#v", again.Code, result)
	}
}
