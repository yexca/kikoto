package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

type genreNameTestClient struct{ calls []string }

func (*genreNameTestClient) FetchProduct(context.Context, string) (dlsite.Product, error) {
	return dlsite.Product{}, errors.New("unexpected unlocalized request")
}

func (*genreNameTestClient) DownloadCover(context.Context, dlsite.Product, string) (string, error) {
	return "", errors.New("unexpected cover request")
}

func (c *genreNameTestClient) FetchProductWithLocale(_ context.Context, code, locale string) (dlsite.Product, error) {
	c.calls = append(c.calls, code+" "+locale)
	return dlsite.Product{WorkNo: code, ProductName: "Example localized title", Genres: []dlsite.Genre{
		{ID: 11, Name: "Example Genre " + locale, NameBase: "Example Genre JA"},
	}}, nil
}

// setGenreNameUserLanguages stores a user's personal metadata language
// priority directly, without the request side effect of queueing learning.
func setGenreNameUserLanguages(t *testing.T, db *sql.DB, name, languages string) {
	t.Helper()
	userID, _ := metadataLanguageUser(t, db, name)
	setUserMetadataLanguages(t, db, userID, languages)
}

// newGenreNameFixture seeds one work with an unnamed genre. A non-empty
// userLanguages gives one user that personal priority.
func newGenreNameFixture(t *testing.T, userLanguages string) (*Server, *sql.DB, *genreNameTestClient) {
	t.Helper()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	client := &genreNameTestClient{}
	server.dlsiteClient = client
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	if userLanguages != "" {
		setGenreNameUserLanguages(t, db, "synthetic-genre-language", userLanguages)
	}
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, 'Example Work')", testfixture.WorkCode(testfixture.PrefixRJ, 50))
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := result.LastInsertId()
	if _, err := db.Exec(`INSERT INTO work_dlsite_genre (work_id, genre_id) VALUES (?, 11);
		INSERT INTO dlsite_genre_name (genre_id, language, name) VALUES (11, 'ja-jp', 'Example Genre JA')`, workID); err != nil {
		t.Fatal(err)
	}
	return server, db, client
}

// Learning is queued only for a user's preferred non-Japanese language with
// unnamed genres, and a second request joins the queued run.
func TestGenreNameLearningQueuesOneRunOnlyWhenNamesAreMissing(t *testing.T) {
	server, db, _ := newGenreNameFixture(t, "")
	ctx := context.Background()
	if runID, err := server.enqueueGenreNameLearning(ctx, "test"); err != nil || runID != 0 {
		t.Fatalf("origin-only languages queued %d %v", runID, err)
	}
	setGenreNameUserLanguages(t, db, "synthetic-genre-language-zh", `["zh-cn","origin"]`)
	first, err := server.enqueueGenreNameLearning(ctx, "test")
	if err != nil || first == 0 {
		t.Fatalf("missing names did not queue: %d %v", first, err)
	}
	second, err := server.enqueueGenreNameLearning(ctx, "test")
	if err != nil || second != first {
		t.Fatalf("second request = %d, want %d (%v)", second, first, err)
	}
	var total int
	if err := db.QueryRow("SELECT progress_total FROM workflow_job WHERE workflow_run_id = ?", first).Scan(&total); err != nil || total != 1 {
		t.Fatalf("progress total = %d %v", total, err)
	}
}

// A user choosing a personal language queues learning; the run learns the
// names, reports progress and results in Activity, and leaves nothing pending.
func TestGenreNameLearningRunsAfterLanguagePriorityChange(t *testing.T) {
	server, db, client := newGenreNameFixture(t, "")
	userID, _ := metadataLanguageUser(t, db, "synthetic-genre-language-en")
	if response := patchMetadataLanguages(t, server, userID, `{"metadataLanguages":["en-us"]}`); response.Code != http.StatusOK {
		t.Fatalf("preferences: %d %s", response.Code, response.Body)
	}
	var runID int64
	if err := db.QueryRow("SELECT id FROM workflow_run WHERE workflow_code = ? AND trigger_reason = 'language_priority'", genreNameWorkflowCode).Scan(&runID); err != nil {
		t.Fatalf("language change did not queue learning: %v", err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(client.calls) != 1 || client.calls[0] != testfixture.WorkCode(testfixture.PrefixRJ, 50)+" en-us" {
		t.Fatalf("requests = %v", client.calls)
	}
	var status, summary string
	var current, total int
	if err := db.QueryRow(`SELECT run.status, run.summary_json, job.progress_current, job.progress_total
		FROM workflow_run AS run JOIN workflow_job AS job ON job.workflow_run_id = run.id WHERE run.id = ?`, runID).Scan(&status, &summary, &current, &total); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || current != 1 || total != 1 || !strings.Contains(summary, `"learnedNames":1`) || strings.Contains(summary, "Example localized title") {
		t.Fatalf("run = %s %d/%d %s", status, current, total, summary)
	}
	var name, display string
	if err := db.QueryRow("SELECT name FROM dlsite_genre_name WHERE genre_id = 11 AND language = 'en-us'").Scan(&name); err != nil || name != "Example Genre en-us" {
		t.Fatalf("learned name = %q %v", name, err)
	}
	// The learned name serves that user; the stored shared name stays in the
	// original language.
	if err := db.QueryRow(`SELECT tag.display_name FROM tag JOIN metadata_tag AS concept ON concept.tag_id = tag.id WHERE concept.dlsite_genre_id = 11`).Scan(&display); err != nil || display != "Example Genre JA" {
		t.Fatalf("display name = %q %v", display, err)
	}
	if runID, err := server.enqueueGenreNameLearning(context.Background(), "test"); err != nil || runID != 0 {
		t.Fatalf("nothing left to learn but queued %d %v", runID, err)
	}
}

// A finished metadata sync may have learned new genre ids, so its completion
// queues learning for them; other jobs do not.
func TestMetadataSyncCompletionQueuesGenreNameLearning(t *testing.T) {
	server, db, _ := newGenreNameFixture(t, `["ko-kr","origin"]`)
	ctx := context.Background()
	server.notifyWorkflowJobCompletion(ctx, workflowJobRecord{WorkerType: "local_library_scan"}, nil)
	var runs int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", genreNameWorkflowCode).Scan(&runs); err != nil || runs != 0 {
		t.Fatalf("unrelated job queued learning: %d %v", runs, err)
	}
	server.notifyWorkflowJobCompletion(ctx, workflowJobRecord{WorkerType: "metadata_family_sync"}, nil)
	var reason string
	if err := db.QueryRow("SELECT trigger_reason FROM workflow_run WHERE workflow_code = ?", genreNameWorkflowCode).Scan(&reason); err != nil || reason != "metadata_sync" {
		t.Fatalf("metadata sync did not queue learning: %q %v", reason, err)
	}
}
