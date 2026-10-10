package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

// A value of the wrong type is reported for the field it was sent in, so the
// caller knows which input to correct.
func TestUpdateSettingsNamesTheFieldWithTheWrongType(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	for body, want := range map[string]string{
		`{"cacheLimitGb":1.5}`:      "cacheLimitGb must be a whole number",
		`{"localScanDepth":"deep"}`: "localScanDepth must be a whole number",
		`{"cacheEnabled":"yes"}`:    "cacheEnabled must be true or false",
		`{"cacheLimitGb":`:          "invalid JSON body",
	} {
		response := patchSettingsAsSourceWriter(t, server, body)
		var result errorResponseBody
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusBadRequest || result.Error != want {
			t.Fatalf("PATCH %s = %d %q, want 400 %q", body, response.Code, result.Error, want)
		}
	}
}

// A scan depth the Fetch folders outgrew only blocks a save that sets the scan
// depth. Other settings save, and the conflict is reported under its own code.
func TestUpdateSettingsChecksScanDepthOnlyWhenItIsSent(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO app_setting (key, value_json) VALUES ('local_scan_depth', '2')`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled, config_json)
			VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', 1, '{"saveRootTemplate":"remote/{source}/{prefix}/{group}/{code}"}')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})

	if response := patchSettingsAsSourceWriter(t, server, `{"cacheLimitGb":80}`); response.Code != http.StatusOK {
		t.Fatalf("saving an unrelated setting = %d %s, want 200", response.Code, response.Body.String())
	}
	response := patchSettingsAsSourceWriter(t, server, `{"cacheLimitGb":90,"localScanDepth":2}`)
	var result errorResponseBody
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusBadRequest || result.Code != "scan_depth_too_shallow" || !strings.Contains(result.Error, "localScanDepth") {
		t.Fatalf("saving a too-shallow scan depth = %d %+v, want 400 scan_depth_too_shallow", response.Code, result)
	}
}
