package metasync

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"sort"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// genreNameClient answers locale requests with each work's genres; a genre
// listed in unnamed answers without a localized name.
type genreNameClient struct {
	mu      sync.Mutex
	genres  map[string][]int64
	unnamed map[int64]bool
	fail    map[string]error
	calls   []string
}

func (c *genreNameClient) FetchProduct(context.Context, string) (dlsite.Product, error) {
	return dlsite.Product{}, errors.New("unexpected unlocalized request")
}

func (*genreNameClient) DownloadCover(context.Context, dlsite.Product, string) (string, error) {
	return "", errors.New("unexpected cover request")
}

func (c *genreNameClient) FetchProductWithLocale(_ context.Context, code, locale string) (dlsite.Product, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, code+" "+locale)
	if err := c.fail[code]; err != nil {
		return dlsite.Product{}, err
	}
	ids, ok := c.genres[code]
	if !ok {
		return dlsite.Product{}, dlsite.ErrNoProduct
	}
	product := dlsite.Product{WorkNo: code, ProductName: "Example localized title", RequestLocale: locale}
	for _, id := range ids {
		name := "Example Genre " + locale + " " + string(rune('0'+id))
		if c.unnamed[id] {
			name = ""
		}
		product.Genres = append(product.Genres, dlsite.Genre{ID: dlsite.GenreID(id), Name: name, NameBase: "Example Genre JA " + string(rune('0'+id))})
	}
	return product, nil
}

func seedGenreWorks(t *testing.T, db *sql.DB, works map[int][]int64) map[int]int64 {
	t.Helper()
	ids := map[int]int64{}
	ordinals := make([]int, 0, len(works))
	for ordinal := range works {
		ordinals = append(ordinals, ordinal)
	}
	sort.Ints(ordinals)
	for _, ordinal := range ordinals {
		genres := works[ordinal]
		result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", testfixture.WorkCode(testfixture.PrefixRJ, ordinal), "Example Work")
		if err != nil {
			t.Fatal(err)
		}
		ids[ordinal], _ = result.LastInsertId()
		for _, genre := range genres {
			if _, err := db.Exec("INSERT INTO work_dlsite_genre (work_id, genre_id) VALUES (?, ?)", ids[ordinal], genre); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO dlsite_genre_name (genre_id, language, name) VALUES (?, 'ja-jp', ?)
				ON CONFLICT DO NOTHING`, genre, "Example Genre JA "+string(rune('0'+genre))); err != nil {
				t.Fatal(err)
			}
		}
	}
	return ids
}

func genreName(t *testing.T, db *sql.DB, genre int64, language string) string {
	t.Helper()
	var name string
	err := db.QueryRow("SELECT name FROM dlsite_genre_name WHERE genre_id = ? AND language = ?", genre, language).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return name
}

// Requests scale with unnamed genres, not works: the work covering the most
// unnamed genres is asked first, and a genre no answer names is not requested
// again. Only names are learned; titles, works and snapshots stay untouched.
func TestLearnGenreNamesRequestsPerMissingGenreSet(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('dlsite_metadata_languages', '["zh-cn","origin"]')`); err != nil {
		t.Fatal(err)
	}
	works := seedGenreWorks(t, db, map[int][]int64{30: {1, 2, 3}, 31: {2, 3, 4}, 32: {5}, 33: {1}})
	if _, err := db.Exec(`INSERT INTO dlsite_genre_name (genre_id, language, name) VALUES (1, 'zh-cn', 'Example Known Genre')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("DELETE FROM work_search_dirty"); err != nil {
		t.Fatal(err)
	}
	client := &genreNameClient{
		genres:  map[string][]int64{testfixture.WorkCode(testfixture.PrefixRJ, 30): {1, 2, 3}, testfixture.WorkCode(testfixture.PrefixRJ, 31): {2, 3, 4}, testfixture.WorkCode(testfixture.PrefixRJ, 32): {5}, testfixture.WorkCode(testfixture.PrefixRJ, 33): {1}},
		unnamed: map[int64]bool{4: true},
	}
	syncer := NewDLsiteSyncer(db, client)
	languages := GenreNameLearningLanguages([]string{"origin", "ja-jp", "zh-cn"})
	if len(languages) != 1 || languages[0] != "zh-cn" {
		t.Fatalf("languages = %v", languages)
	}
	if pending, err := PendingGenreNames(ctx, db, languages); err != nil || pending != 4 {
		t.Fatalf("pending = %d %v", pending, err)
	}

	result, err := syncer.LearnGenreNames(ctx, languages, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{testfixture.WorkCode(testfixture.PrefixRJ, 31) + " zh-cn", testfixture.WorkCode(testfixture.PrefixRJ, 32) + " zh-cn"}
	if len(client.calls) != 2 || client.calls[0] != want[0] || client.calls[1] != want[1] {
		t.Fatalf("requests = %v, want %v", client.calls, want)
	}
	if result.Requests != 2 || result.LearnedNames != 3 || result.Exhausted != 1 || result.Remaining != 0 {
		t.Fatalf("result = %+v", result)
	}
	for genre, want := range map[int64]string{1: "Example Known Genre", 2: "Example Genre zh-cn 2", 3: "Example Genre zh-cn 3", 4: "", 5: "Example Genre zh-cn 5"} {
		if got := genreName(t, db, genre, "zh-cn"); got != want {
			t.Errorf("genre %d zh-cn name = %q, want %q", genre, got, want)
		}
	}
	var exhausted bool
	if err := db.QueryRow("SELECT exhausted FROM dlsite_genre_name_gap WHERE genre_id = 4 AND language = 'zh-cn'").Scan(&exhausted); err != nil || !exhausted {
		t.Fatalf("unnamed genre not exhausted: %v %v", exhausted, err)
	}
	var displayName string
	if err := db.QueryRow(`SELECT tag.display_name FROM tag JOIN metadata_tag AS concept ON concept.tag_id = tag.id WHERE concept.dlsite_genre_id = 2`).Scan(&displayName); err != nil || displayName != "Example Genre zh-cn 2" {
		t.Fatalf("display name = %q %v", displayName, err)
	}
	var dirty int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_search_dirty WHERE work_id IN (?, ?, ?)", works[30], works[31], works[32]).Scan(&dirty); err != nil || dirty != 3 {
		t.Fatalf("search documents invalidated = %d %v", dirty, err)
	}
	var workCount, snapshots, variants, editions int
	var title string
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM work), (SELECT COUNT(*) FROM metadata_snapshot), (SELECT COUNT(*) FROM dlsite_metadata_variant),
		(SELECT COUNT(*) FROM work_edition), (SELECT title FROM work WHERE id = ?)`, works[31]).Scan(&workCount, &snapshots, &variants, &editions, &title); err != nil {
		t.Fatal(err)
	}
	if workCount != 5 || snapshots != 0 || variants != 0 || editions != 0 || title != "Example Work" {
		t.Fatalf("learning wrote more than names: works=%d snapshots=%d variants=%d editions=%d title=%q", workCount, snapshots, variants, editions, title)
	}

	client.calls = nil
	if result, err := syncer.LearnGenreNames(ctx, languages, nil); err != nil || len(client.calls) != 0 || result.Requests != 0 {
		t.Fatalf("second pass requested again: %v %+v %v", client.calls, result, err)
	}
}

// A rate limit stops the pass without recording the request, so the retried
// pass asks again; a missing product is recorded and counts against its genres,
// and a work DLsite already reported as not found is never asked.
func TestLearnGenreNamesResumesAfterRetryableFailure(t *testing.T) {
	db := openTestDB(t)
	ctx := context.Background()
	works := seedGenreWorks(t, db, map[int][]int64{40: {7}, 41: {7}, 42: {8}, 43: {9}})
	if _, err := db.Exec(`INSERT INTO work_metadata_provider_state (work_id, provider_id, status)
		SELECT ?, id, 'not_found' FROM metadata_provider WHERE code = 'dlsite'`, works[43]); err != nil {
		t.Fatal(err)
	}
	first, second, third := testfixture.WorkCode(testfixture.PrefixRJ, 40), testfixture.WorkCode(testfixture.PrefixRJ, 41), testfixture.WorkCode(testfixture.PrefixRJ, 42)
	client := &genreNameClient{
		genres: map[string][]int64{second: {7}, third: {8}},
		fail:   map[string]error{third: dlsite.HTTPStatusError{Operation: "product", StatusCode: http.StatusServiceUnavailable}},
	}
	syncer := NewDLsiteSyncer(db, client)
	_, err := syncer.LearnGenreNames(ctx, []string{"en-us"}, nil)
	if !dlsite.IsRetryableHTTPError(err) {
		t.Fatalf("pass error = %v", err)
	}
	var requests int
	if err := db.QueryRow("SELECT COUNT(*) FROM dlsite_genre_name_request WHERE work_id = (SELECT id FROM work WHERE primary_code = ?)", third).Scan(&requests); err != nil || requests != 0 {
		t.Fatalf("failed request recorded: %d %v", requests, err)
	}

	delete(client.fail, third)
	client.calls = nil
	result, err := syncer.LearnGenreNames(ctx, []string{"en-us"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// The first work is no longer published; the next work carrying genre 7
	// names it, and the rate-limited genre 8 is learned on the retried pass.
	if genreName(t, db, 7, "en-us") == "" || genreName(t, db, 8, "en-us") == "" || result.Remaining != 0 {
		t.Fatalf("resumed pass: calls=%v result=%+v", client.calls, result)
	}
	for _, call := range client.calls {
		if call == testfixture.WorkCode(testfixture.PrefixRJ, 43)+" en-us" {
			t.Fatalf("not-found work requested: %v", client.calls)
		}
	}
	var exhausted bool
	if err := db.QueryRow("SELECT exhausted FROM dlsite_genre_name_gap WHERE genre_id = 9 AND language = 'en-us'").Scan(&exhausted); err != nil || !exhausted {
		t.Fatalf("genre without a requestable work stayed pending: %v %v", exhausted, err)
	}
	var outcome string
	if err := db.QueryRow(`SELECT outcome FROM dlsite_genre_name_request WHERE language = 'en-us'
		AND work_id = (SELECT id FROM work WHERE primary_code = ?)`, first).Scan(&outcome); err != nil || outcome != "not_found" {
		t.Fatalf("missing product outcome = %q %v", outcome, err)
	}
}
