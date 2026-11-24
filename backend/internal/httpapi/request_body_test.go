package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestOptionalBodyAcceptsAnAbsentBodyAndBoundsAPresentOne(t *testing.T) {
	type request struct {
		SourceID int64 `json:"sourceId"`
	}
	for _, test := range []struct {
		name   string
		body   string
		limit  int64
		want   int64
		status int
	}{
		{name: "empty", body: "", want: 7},
		{name: "whitespace", body: " \n", want: 7},
		{name: "present", body: `{"sourceId":3}`, want: 3},
		{name: "too large", body: `{"sourceId":3}`, limit: 4, status: http.StatusRequestEntityTooLarge},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			httpRequest := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(test.body))
			payload := request{SourceID: 7}
			var ok bool
			if test.limit > 0 {
				ok = decodeOptionalJSON(response, json.NewDecoder(http.MaxBytesReader(response, httpRequest.Body, test.limit)), &payload)
			} else {
				ok = decodeOptionalJSONBody(response, httpRequest, &payload)
			}
			if test.status != 0 {
				if ok || response.Code != test.status {
					t.Fatalf("decode = %t, status %d; want refused with %d", ok, response.Code, test.status)
				}
				return
			}
			if !ok || payload.SourceID != test.want {
				t.Fatalf("decode = %t, sourceId %d %s; want accepted with %d", ok, payload.SourceID, response.Body.String(), test.want)
			}
		})
	}
}

func TestMistypedOptionalBodyAnswersBadRequestWithoutRunning(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: t.TempDir()})
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	permissions := []string{"metadata:sync", "remote:track", "remote:fetch"}
	remote := "/api/remote-sources/1/works/" + code
	remoteValues := map[string]string{"id": "1", "code": code}
	for _, action := range []struct {
		name    string
		handler http.HandlerFunc
		target  string
		body    string
		values  map[string]string
		message string
	}{
		{"source check", server.checkWorkSourceAvailabilityNow, "/api/works/" + code + "/source-availability", `{"sourceId":"abc"}`, map[string]string{"code": code}, "sourceId must be a whole number"},
		{"remote track", server.trackRemoteSourceWork, remote + "/track", `{"triggerReason":1}`, remoteValues, "triggerReason must be text"},
		{"remote sync", server.syncRemoteSourceWork, remote + "/sync", `{"listeningStatus":true}`, remoteValues, "listeningStatus must be text"},
		{"remote Fetch", server.saveRemoteSourceWork, remote + "/fetch", `{"minFreeBytes":"2GB"}`, remoteValues, "minFreeBytes must be a whole number"},
		{"remote Fetch plan", server.planRemoteSourceWorkSave, remote + "/fetch-plan", `{"paths":`, remoteValues, "invalid JSON body"},
	} {
		request := customWorkRequest(http.MethodPost, action.target, action.body, permissions...)
		for key, value := range action.values {
			request.SetPathValue(key, value)
		}
		response := httptest.NewRecorder()
		action.handler(response, request)
		var body struct {
			Error string `json:"error"`
			Code  string `json:"code"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s body %q: %v", action.name, response.Body.String(), err)
		}
		if response.Code != http.StatusBadRequest || body.Code != "invalid_request" || body.Error != action.message {
			t.Fatalf("%s = %d %+v, want 400 invalid_request %q", action.name, response.Code, body, action.message)
		}
	}
	var runs int
	if err := server.db.QueryRow("SELECT COUNT(*) FROM workflow_run").Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("workflow runs = %d, %v; want none", runs, err)
	}
}
