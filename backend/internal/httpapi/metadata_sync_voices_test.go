package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// Bulk metadata sync must populate the voice list without a restart or a
// work-detail refresh, including when another work fails or a snapshot exists.
func TestBulkMetadataSyncPopulatesVoiceList(t *testing.T) {
	for _, scenario := range []struct {
		name             string
		existingSnapshot bool
		failedWork       bool
	}{
		{name: "fresh sync"},
		{name: "partial sync", failedWork: true},
		{name: "repair existing snapshot", existingSnapshot: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := context.Background()
			db := openMigratedTestDB(t)
			code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
			product := dlsite.Product{
				WorkNo: code, ProductName: "Example Work",
				Creators: dlsite.Creators{"voice_by": {{Name: "Example Voice"}}},
			}
			raw, err := json.Marshal(product)
			if err != nil {
				t.Fatal(err)
			}
			product.Raw = raw
			if _, err := db.Exec("INSERT INTO work (id, primary_code, title) VALUES (1, ?, 'Example Work')", code); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
				t.Fatal(err)
			}
			client := &fakeDemoScanDLsiteClient{
				products: map[string]dlsite.Product{code: product},
				errors:   map[string]error{}, calls: map[string]int{},
			}
			if scenario.existingSnapshot {
				if _, err := db.Exec(`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
					SELECT 1, id, ?, ? FROM metadata_provider WHERE code = 'dlsite'`, code, string(raw)); err != nil {
					t.Fatal(err)
				}
			}
			if scenario.failedWork {
				failedCode := testfixture.WorkCode(testfixture.PrefixRJ, 1)
				if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, 'Example Work 2')", failedCode); err != nil {
					t.Fatal(err)
				}
				client.errors[failedCode] = errors.New("synthetic metadata failure")
			}
			server := NewServer(db, config.Config{})
			server.dlsiteClient = client
			// A second incremental run must keep one actor and one credited work.
			for attempt := 0; attempt < 2; attempt++ {
				run, err := server.enqueueDLsiteMetadataSync(ctx, "manual", "manual")
				if err != nil {
					t.Fatal(err)
				}
				job, ok, err := server.claimNextQueuedWorkflowJob(ctx, "metadata-voice-test")
				if err != nil || !ok || job.RunID != run.RunID {
					t.Fatalf("claim metadata job = %+v, %t, %v", job, ok, err)
				}
				if err := server.executeDLsiteMetadataSyncJob(ctx, job); err != nil {
					t.Fatal(err)
				}
				voices, err := server.loadVoiceSummaries(ctx, 0)
				if err != nil {
					t.Fatal(err)
				}
				if len(voices) != 1 || voices[0].DisplayName != "Example Voice" || voices[0].KnownWorks != 1 {
					t.Fatalf("voices after bulk sync = %+v, want Example Voice with one work", voices)
				}
				var status, summary string
				if err := db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", run.RunID).Scan(&status, &summary); err != nil {
					t.Fatal(err)
				}
				wantStatus := "succeeded"
				if scenario.failedWork {
					wantStatus = "partial"
					if attempt > 0 {
						wantStatus = "failed"
					}
				}
				if status != wantStatus {
					t.Fatalf("run status = %q, want %q; summary = %s", status, wantStatus, summary)
				}
			}
			wantCalls := 1
			if scenario.existingSnapshot {
				wantCalls = 0
			}
			if client.calls[code] != wantCalls {
				t.Fatalf("metadata requests = %d, want %d", client.calls[code], wantCalls)
			}
		})
	}
}
