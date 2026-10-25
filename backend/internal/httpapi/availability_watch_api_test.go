package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

	unauthorizedFetch := httptest.NewRecorder()
	server.updateAvailabilityWatch(unauthorizedFetch, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"action":"fetch"}`,
		&listener,
	))
	if unauthorizedFetch.Code != http.StatusForbidden {
		t.Fatalf("fetch without downloads status = %d, body = %s", unauthorizedFetch.Code, unauthorizedFetch.Body.String())
	}

	invalidAction := httptest.NewRecorder()
	server.updateAvailabilityWatch(invalidAction, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"action":"invalid"}`,
		&actor,
	))
	if invalidAction.Code != http.StatusBadRequest {
		t.Fatalf("invalid action status = %d, body = %s", invalidAction.Code, invalidAction.Body.String())
	}

	invalidSource := httptest.NewRecorder()
	server.updateAvailabilityWatch(invalidSource, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"action":"track","sourceId":999}`,
		&actor,
	))
	if invalidSource.Code != http.StatusBadRequest {
		t.Fatalf("invalid source status = %d, body = %s", invalidSource.Code, invalidSource.Body.String())
	}

	update := httptest.NewRecorder()
	server.updateAvailabilityWatch(update, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"action":"track","sourceId":1,"excludeExtensions":[".MP3","wav","mp3"," "]}`,
		&actor,
	))
	var configured availabilityWatchView
	if err := json.NewDecoder(update.Body).Decode(&configured); err != nil {
		t.Fatal(err)
	}
	if update.Code != http.StatusOK || configured.ID != availabilityWatchID || configured.Action != "track" || configured.SourceID == nil || *configured.SourceID != 1 {
		t.Fatalf("configured status = %d, view = %#v", update.Code, configured)
	}
	if strings.Join(configured.ExcludeExtensions, ",") != "mp3,wav" {
		t.Fatalf("normalized extensions = %#v", configured.ExcludeExtensions)
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

	// Reconfigure a monitor-only watch so the run endpoint can exercise queue
	// conflict handling without contacting a remote source.
	reconfigure := httptest.NewRecorder()
	server.updateAvailabilityWatch(reconfigure, availabilityWatchAPIRequest(
		http.MethodPut,
		"/api/availability-watch",
		`{"action":"monitor"}`,
		&actor,
	))
	if reconfigure.Code != http.StatusOK {
		t.Fatalf("reconfigure status = %d, body = %s", reconfigure.Code, reconfigure.Body.String())
	}

	queued := httptest.NewRecorder()
	server.runAvailabilityWatch(queued, availabilityWatchAPIRequest(http.MethodPost, "/api/availability-watch/run", "", &actor))
	if queued.Code != http.StatusAccepted {
		t.Fatalf("run status = %d, body = %s", queued.Code, queued.Body.String())
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

func TestAvailabilityWatchClearCompletedRemovesOnlyListedCompletedTargets(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-clear-user', 'admin')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO availability_watch (id, configured_by_user_id, action) VALUES (1, 1, 'monitor')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO availability_watch_target (id, watch_id, work_code, active, state) VALUES
			(1, 1, 'RJ00000001', 1, 'completed'),
			(2, 1, 'RJ00000002', 1, 'ready'),
			(3, 1, 'RJ00000003', 1, 'completed'),
			(4, 1, 'RJ00000004', 1, 'monitoring')
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 1, Role: "admin", Permissions: account.PermissionsForRole("admin")}

	invalid := httptest.NewRecorder()
	server.clearCompletedAvailabilityWatchTargets(invalid, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/targets/clear-completed", `{"targetIds":[0]}`, &actor,
	))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid id status = %d, body = %s", invalid.Code, invalid.Body.String())
	}

	// Target 3 completed after the list was shown, so it is not listed and stays.
	cleared := httptest.NewRecorder()
	server.clearCompletedAvailabilityWatchTargets(cleared, availabilityWatchAPIRequest(
		http.MethodPost, "/api/availability-watch/targets/clear-completed", `{"targetIds":[1,2,4]}`, &actor,
	))
	if cleared.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body = %s", cleared.Code, cleared.Body.String())
	}
	var view availabilityWatchView
	if err := json.NewDecoder(cleared.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	codes := make([]string, 0, len(view.Targets))
	for _, target := range view.Targets {
		codes = append(codes, target.WorkCode)
	}
	if strings.Join(codes, ",") != "RJ00000002,RJ00000003,RJ00000004" {
		t.Fatalf("remaining targets = %v", codes)
	}
	var state string
	var active int
	if err := db.QueryRow(`SELECT active, state FROM availability_watch_target WHERE id = 1`).Scan(&active, &state); err != nil {
		t.Fatal(err)
	}
	if active != 0 || state != "disabled" {
		t.Fatalf("cleared target active = %d, state = %q", active, state)
	}
}

func TestAvailabilityWatchMonitorRequiresMetadataSync(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, role) VALUES (1, 'watch-permission-user', 'contributor')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO availability_watch (id, configured_by_user_id, action) VALUES (1, 1, 'monitor')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 1, Permissions: []string{"workflows:run"}}
	for _, test := range []struct {
		method, target, body string
		handler              http.HandlerFunc
	}{
		{http.MethodPut, "/api/availability-watch", `{"action":"monitor"}`, server.updateAvailabilityWatch},
		{http.MethodPost, "/api/availability-watch/run", `{}`, server.runAvailabilityWatch},
		{http.MethodPost, "/api/availability-watch/targets", `{"targetCodes":["RJ00000001"]}`, server.addAvailabilityWatchTargets},
		{http.MethodPost, "/api/availability-watch/targets/clear-completed", `{"targetIds":[1]}`, server.clearCompletedAvailabilityWatchTargets},
	} {
		response := httptest.NewRecorder()
		test.handler(response, availabilityWatchAPIRequest(test.method, test.target, test.body, &actor))
		if response.Code != http.StatusForbidden {
			t.Fatalf("%s %s = %d, want 403: %s", test.method, test.target, response.Code, response.Body.String())
		}
	}
}
