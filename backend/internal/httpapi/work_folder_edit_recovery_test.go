package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// stageFolderEditForRecovery leaves the real job at its durable collection
// checkpoint. A caller can perform a publication rename and discard its
// in-memory execution to exercise the gap before the next checkpoint.
func stageFolderEditForRecovery(t *testing.T, fixture folderEditFixture, job workflowJobRecord) *workFolderEditExecution {
	t.Helper()
	execution := &workFolderEditExecution{server: fixture.server, job: job}
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &execution.payload); err != nil {
		t.Fatal(err)
	}
	var err error
	execution.nodes, err = workflowNodeIDsByNodeID(context.Background(), fixture.db, job.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if err := execution.locate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := execution.stage(context.Background()); err != nil {
		t.Fatal(err)
	}
	return execution
}

func resumeFolderEditFromStorage(t *testing.T, fixture folderEditFixture, job workflowJobRecord) error {
	t.Helper()
	if err := fixture.db.QueryRow("SELECT checkpoint_json FROM workflow_job WHERE id = ?", job.ID).Scan(&job.CheckpointJSON); err != nil {
		t.Fatal(err)
	}
	server := NewServer(fixture.db, fixture.server.cfg)
	return server.executeWorkFolderEditJob(context.Background(), job)
}

func TestWorkFolderEditRecoversPublicationBeforeCheckpoint(t *testing.T) {
	for _, source := range []string{"local", "remote"} {
		t.Run(source, func(t *testing.T) {
			fixture := newFolderEditFixture(t, serveFolderEditMedia)
			var addition map[string]any
			name, content := folderEditAudioPath, folderEditRemoteAudio
			if source == "local" {
				name, content = "added.txt", "synthetic added file"
				folderID := fixture.addSiblingFolder(t, map[string]string{name: content})
				addition = localAddition(folderID, name)
			} else {
				addition = remoteAddition("RJ00000002", name)
			}
			job := fixture.apply(t, map[string]any{"additions": []any{addition}})
			execution := stageFolderEditForRecovery(t, fixture, job)
			if err := execution.publishItem(0, execution.payload.Items[0]); err != nil {
				t.Fatal(err)
			}
			// Neither the old source nor an upstream request is needed once
			// this exact collected file has reached its target.
			if source == "local" {
				absolute, err := safeDataPath(fixture.dataRoot, execution.payload.Items[0].LocalSourcePath)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(absolute); err != nil {
					t.Fatal(err)
				}
			} else if _, err := fixture.db.Exec("UPDATE file_source SET enabled = 0 WHERE id = 7"); err != nil {
				t.Fatal(err)
			}
			requests := fixture.requests.Load()
			if err := resumeFolderEditFromStorage(t, fixture, job); err != nil {
				t.Fatalf("resume after publication rename: %v", err)
			}
			if got, err := os.ReadFile(fixture.targetFile(name)); err != nil || string(got) != content {
				t.Fatalf("published file = %q, %v", got, err)
			}
			if status := fixture.runStatus(t, job.RunID); status != "succeeded" {
				t.Fatalf("resumed run = %q", status)
			}
			if fixture.requests.Load() != requests {
				t.Fatal("recovery consulted the source after publication")
			}
			if _, found := fixture.locations(t)[name]; !found {
				t.Fatal("recovered publication was not indexed")
			}
			fixture.assertNoEditStaging(t)
		})
	}
}

func TestWorkFolderEditRecoveryKeepsChangedPublication(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	const name, content = "added.txt", "synthetic added file"
	folderID := fixture.addSiblingFolder(t, map[string]string{name: content})
	job := fixture.apply(t, map[string]any{"additions": []any{localAddition(folderID, name)}})
	execution := stageFolderEditForRecovery(t, fixture, job)
	if err := execution.publishItem(0, execution.payload.Items[0]); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(fixture.targetFile(name))
	if err != nil {
		t.Fatal(err)
	}
	changed := strings.Repeat("x", len(content))
	if err := os.WriteFile(fixture.targetFile(name), []byte(changed), 0o644); err != nil {
		t.Fatal(err)
	}
	// Size and modification time alone cannot prove publication ownership.
	if err := os.Chtimes(fixture.targetFile(name), info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	if err := resumeFolderEditFromStorage(t, fixture, job); err == nil {
		t.Fatal("a different target was accepted as this run's published file")
	}
	if got, err := os.ReadFile(fixture.targetFile(name)); err != nil || string(got) != changed {
		t.Fatalf("changed target was overwritten: %q, %v", got, err)
	}
}

func TestWorkFolderEditRecoveryRejectsLinkedPublicationParent(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	const name, content = "Added/added.txt", "synthetic added file"
	folderID := fixture.addSiblingFolder(t, map[string]string{name: content})
	job := fixture.apply(t, map[string]any{"additions": []any{localAddition(folderID, name)}})
	execution := stageFolderEditForRecovery(t, fixture, job)
	if err := execution.publishItem(0, execution.payload.Items[0]); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Rename(fixture.targetFile("Added"), filepath.Join(outside, "Added")); err != nil {
		t.Fatal(err)
	}
	linkFetchTestDirectory(t, filepath.Join(outside, "Added"), fixture.targetFile("Added"))
	if err := resumeFolderEditFromStorage(t, fixture, job); err == nil {
		t.Fatal("recovery accepted a file reached through a linked parent")
	}
	if got, err := os.ReadFile(filepath.Join(outside, "Added", "added.txt")); err != nil || string(got) != content {
		t.Fatalf("outside file changed: %q, %v", got, err)
	}
}

func TestWorkFolderEditResumesCollectedLegacyCheckpoint(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	const name = "added.txt"
	folderID := fixture.addSiblingFolder(t, map[string]string{name: "synthetic added file"})
	job := fixture.apply(t, map[string]any{"additions": []any{localAddition(folderID, name)}})
	stageFolderEditForRecovery(t, fixture, job)
	// A checkpoint written by an earlier binary has no publication proof.
	if _, err := fixture.db.Exec("UPDATE workflow_job SET checkpoint_json = json_remove(checkpoint_json, '$.detail.staged_files') WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if err := resumeFolderEditFromStorage(t, fixture, job); err != nil {
		t.Fatalf("a legacy checkpoint with its collected file cannot resume: %v", err)
	}
	fixture.assertNoEditStaging(t)
}

func TestWorkFolderEditRecoveryRefusesUnprovenLegacyPublication(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	const name, content = "added.txt", "synthetic added file"
	folderID := fixture.addSiblingFolder(t, map[string]string{name: content})
	job := fixture.apply(t, map[string]any{"additions": []any{localAddition(folderID, name)}})
	execution := stageFolderEditForRecovery(t, fixture, job)
	if err := execution.publishItem(0, execution.payload.Items[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET checkpoint_json = json_remove(checkpoint_json, '$.detail.staged_files') WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if err := resumeFolderEditFromStorage(t, fixture, job); err == nil {
		t.Fatal("a missing collected file without publication proof was adopted")
	}
	if got, err := os.ReadFile(fixture.targetFile(name)); err != nil || string(got) != content {
		t.Fatalf("the unproven destination changed: %q, %v", got, err)
	}
}

func TestWorkFolderEditRecoversPartialPublicationWithoutItsSources(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	const name, content = "added.txt", "synthetic added file"
	folderID := fixture.addSiblingFolder(t, map[string]string{name: content})
	job := fixture.apply(t, map[string]any{"additions": []any{
		remoteAddition("RJ00000002", folderEditAudioPath), localAddition(folderID, name),
	}})
	execution := stageFolderEditForRecovery(t, fixture, job)
	if err := execution.publishItem(0, execution.payload.Items[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE file_source SET enabled = 0 WHERE id = 7"); err != nil {
		t.Fatal(err)
	}
	localSource, err := safeDataPath(fixture.dataRoot, execution.payload.Items[1].LocalSourcePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(localSource); err != nil {
		t.Fatal(err)
	}
	requests := fixture.requests.Load()
	if err := resumeFolderEditFromStorage(t, fixture, job); err != nil {
		t.Fatalf("partial publication cannot resume without its sources: %v", err)
	}
	for path, want := range map[string]string{name: content, folderEditAudioPath: folderEditRemoteAudio} {
		if got, err := os.ReadFile(fixture.targetFile(path)); err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v", path, got, err)
		}
	}
	if fixture.requests.Load() != requests {
		t.Fatal("a partially published edit repeated an upstream request")
	}
	fixture.assertNoEditStaging(t)
}

// Keep the publication gap regression on the same pool-scoped staging layout
// as the production folder edit, including storage pool mode.
func TestWorkFolderEditRecoversPublicationOnItsStoragePool(t *testing.T) {
	fixture := newPoolFolderEditFixture(t, serveFolderEditMedia)
	folderID := fixture.addSiblingFolder(t, map[string]string{"added.txt": "synthetic added file"})
	job := fixture.apply(t, map[string]any{"additions": []any{localAddition(folderID, "added.txt")}})
	execution := stageFolderEditForRecovery(t, fixture, job)
	if execution.payload.TransactionPool != fixture.pool || fixture.pool == "" {
		t.Fatal("the edit's collection is not scoped to its target storage pool")
	}
	if err := execution.publishItem(0, execution.payload.Items[0]); err != nil {
		t.Fatal(err)
	}
	if err := resumeFolderEditFromStorage(t, fixture, job); err != nil {
		t.Fatal(err)
	}
	if ok, reason := storagepool.Check(fixture.dataRoot, storagepool.Pool{Path: fixture.pool}, ""); !ok {
		t.Fatalf("target pool = %s", reason)
	}
	fixture.assertNoEditStaging(t)
}
