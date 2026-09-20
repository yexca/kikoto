package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func seedOnboardingLibrary(t *testing.T, s *Server) {
	t.Helper()
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	for _, query := range []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type) VALUES ('local_library_scan', 'Scan library', 'succeeded', 'startup')`,
		`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`,
	} {
		if _, err := s.db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec("INSERT INTO work (id, primary_code, title) VALUES (1, ?, 'Example Work')", code); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO work_folder_location (work_id, file_source_id, root_path) VALUES (1, 1, ?)`, code); err != nil {
		t.Fatal(err)
	}
}

func TestMetadataOnboardingEligibility(t *testing.T) {
	s := NewServer(openMigratedTestDB(t), config.Config{})
	assertStatus := func(want string, count int) {
		t.Helper()
		view, err := s.metadataOnboarding(context.Background())
		if err != nil || view.Status != want || view.MissingWorks != count {
			t.Fatalf("onboarding = %+v, %v; want %s/%d", view, err, want, count)
		}
	}
	assertStatus("waiting", 0)
	seedOnboardingLibrary(t, s)
	if _, err := s.db.Exec("UPDATE workflow_run SET status = 'running'"); err != nil {
		t.Fatal(err)
	}
	assertStatus("waiting", 0)
	if _, err := s.db.Exec("UPDATE workflow_run SET status = 'succeeded'"); err != nil {
		t.Fatal(err)
	}
	assertStatus("ready", 1)
	if _, err := s.db.Exec("UPDATE work_folder_location SET state = 'missing'"); err != nil {
		t.Fatal(err)
	}
	assertStatus("waiting", 0)
	if _, err := s.db.Exec("UPDATE work_folder_location SET state = 'active'"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		SELECT 1, id, ?, '{}' FROM metadata_provider WHERE code = 'dlsite'`, testfixture.WorkCode(testfixture.PrefixRJ, 0)); err != nil {
		t.Fatal(err)
	}
	assertStatus("waiting", 0)
}

func TestMetadataOnboardingDismissalAndPermissions(t *testing.T) {
	s := NewServer(openMigratedTestDB(t), config.Config{})
	seedOnboardingLibrary(t, s)
	for _, handler := range []http.HandlerFunc{s.getMetadataOnboarding, s.startMetadataOnboarding, s.dismissMetadataOnboarding} {
		if response := metadataRequest(handler, http.MethodPost, "/api/metadata/onboarding", "", "library:read"); response.Code != http.StatusForbidden {
			t.Fatalf("unprivileged request = %d", response.Code)
		}
	}
	response := metadataRequest(s.dismissMetadataOnboarding, http.MethodPost, "/api/metadata/onboarding/dismiss", "", "metadata:sync")
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	// Dismissal is durable and shared by other sessions, not browser storage.
	s = NewServer(s.db, config.Config{})
	view, err := s.metadataOnboarding(context.Background())
	if err != nil || view.Status != "hidden" {
		t.Fatalf("dismissed view = %+v, %v", view, err)
	}
	response = metadataRequest(s.startMetadataOnboarding, http.MethodPost, "/api/metadata/onboarding/start", "", "metadata:sync")
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	var runs int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'metadata_sync'").Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("dismissed start created %d runs: %v", runs, err)
	}
	s = NewServer(s.db, config.Config{Mode: "demo"})
	for _, handler := range []http.HandlerFunc{s.startMetadataOnboarding, s.dismissMetadataOnboarding} {
		if response := metadataRequest(handler, http.MethodPost, "/api/metadata/onboarding", "", "metadata:sync"); response.Code != http.StatusForbidden {
			t.Fatalf("Demo mutation = %d", response.Code)
		}
	}
}

func TestMetadataOnboardingStartsOneRunAndNotifies(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[failure], func(t *testing.T) {
			s := NewServer(openMigratedTestDB(t), config.Config{})
			seedOnboardingLibrary(t, s)
			insertCustomWorkflowAPIUser(t, s.db, "synthetic-metadata-user")
			client := &recoveryMetadataClient{}
			if failure {
				client.failure = dlsite.HTTPStatusError{StatusCode: 403, Status: "403 Forbidden"}
			}
			s.dlsiteClient = client
			var runID int64
			for attempt := 0; attempt < 2; attempt++ {
				response := metadataRequest(s.startMetadataOnboarding, http.MethodPost, "/api/metadata/onboarding/start", "", "metadata:sync")
				if response.Code != http.StatusOK && response.Code != http.StatusAccepted {
					t.Fatalf("start = %d %s", response.Code, response.Body)
				}
				var view metadataOnboardingView
				if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
					t.Fatal(err)
				}
				if view.Status != "queued" || view.RunID <= 0 || (runID > 0 && runID != view.RunID) {
					t.Fatalf("duplicate start = %+v", view)
				}
				runID = view.RunID
			}
			job, ok, err := s.claimNextQueuedWorkflowJob(context.Background(), "onboarding-test")
			if err != nil || !ok || job.RunID != runID {
				t.Fatalf("claim = %+v %t %v", job, ok, err)
			}
			if err := s.executeDLsiteMetadataSyncJob(context.Background(), job); err != nil {
				t.Fatal(err)
			}
			var status string
			if err := s.db.QueryRow("SELECT status FROM workflow_notification WHERE workflow_run_id = ? AND notification_type = 'metadata_onboarding'", runID).Scan(&status); err != nil {
				t.Fatal(err)
			}
			want := "succeeded"
			if failure {
				want = "failed"
			}
			view, err := s.metadataOnboarding(context.Background())
			if err != nil || status != want || view.Status != want {
				t.Fatalf("notification = %s, view = %+v, %v", status, view, err)
			}
		})
	}
}
