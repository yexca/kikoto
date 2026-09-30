package kikoeru

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeKikoeruDatabase(t *testing.T, statements ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kikoeru.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	return path
}

const kikoeruSchema = `CREATE TABLE t_user (name TEXT PRIMARY KEY, password TEXT NOT NULL, "group" TEXT NOT NULL);
CREATE TABLE t_review (user_name TEXT NOT NULL, work_id BIGINT NOT NULL, rating INTEGER, review_text TEXT, progress TEXT, PRIMARY KEY (user_name, work_id));`

func TestReadDatabaseReviewsReadsOnlyTheNamedAccount(t *testing.T) {
	path := writeKikoeruDatabase(t, kikoeruSchema,
		`INSERT INTO t_user VALUES ('synthetic-user','synthetic-password','user'),('other-user','synthetic-password','user'),('empty-user','synthetic-password','user')`,
		// Typed numeric ids: 0 is RJ000000 and 2e12 is VJ000000.
		`INSERT INTO t_review VALUES ('synthetic-user',0,5,'Example note','listened'),('synthetic-user',2000000000000,NULL,NULL,'marked'),('other-user',0,1,'Other note','replay')`,
	)
	reviews, err := ReadDatabaseReviews(context.Background(), path, "synthetic-user", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(reviews) != 2 {
		t.Fatalf("reviews = %+v", reviews)
	}
	byID := map[string]AccountReview{}
	for _, review := range reviews {
		byID[string(review.WorkID)] = review
	}
	first, second := byID[`"0"`], byID[`"2000000000000"`]
	if first.Progress != "listened" || first.Rating == nil || *first.Rating != 5 || first.ReviewText != "Example note" {
		t.Fatalf("first review = %+v", first)
	}
	if second.Progress != "marked" || second.Rating != nil || second.ReviewText != "" {
		t.Fatalf("second review = %+v", second)
	}
	if reviews, err := ReadDatabaseReviews(context.Background(), path, "empty-user", 10); err != nil || len(reviews) != 0 {
		t.Fatalf("empty account = %+v, %v", reviews, err)
	}
	if _, err := ReadDatabaseReviews(context.Background(), path, "missing-user", 10); !errors.Is(err, ErrDatabaseUserNotFound) {
		t.Fatalf("missing account error = %v", err)
	}
	if _, err := ReadDatabaseReviews(context.Background(), path, "synthetic-user", 1); !errors.Is(err, ErrAccountLimit) {
		t.Fatalf("limit error = %v", err)
	}
}

func TestReadDatabaseReviewsBoundsTextAndOpensReadOnly(t *testing.T) {
	long := strings.Repeat("文", maxDatabaseReviewTextRunes+5)
	path := writeKikoeruDatabase(t, kikoeruSchema,
		`INSERT INTO t_review VALUES ('synthetic-user',0,NULL,'`+long+`','listening')`,
	)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	reviews, err := ReadDatabaseReviews(context.Background(), path, "synthetic-user", 10)
	if err != nil || len(reviews) != 1 || len([]rune(reviews[0].ReviewText)) != maxDatabaseReviewTextRunes {
		t.Fatalf("bounded text = %d runes, %v", len([]rune(reviews[0].ReviewText)), err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(before) != string(after) {
		t.Fatalf("database file changed while reading: %v", err)
	}
}

func TestReadDatabaseReviewsRejectsUnusableFiles(t *testing.T) {
	notSQLite := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.WriteFile(notSQLite, []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"not sqlite":      notSQLite,
		"no review table": writeKikoeruDatabase(t, `CREATE TABLE t_work (id BIGINT)`),
		// A view would evaluate SQL chosen by the file's author.
		"review view":     writeKikoeruDatabase(t, `CREATE TABLE t_base (user_name TEXT, work_id BIGINT)`, `CREATE VIEW t_review AS SELECT * FROM t_base`),
		"missing columns": writeKikoeruDatabase(t, `CREATE TABLE t_review (work_id BIGINT)`),
	} {
		if _, err := ReadDatabaseReviews(context.Background(), path, "synthetic-user", 10); !errors.Is(err, ErrDatabaseInvalid) {
			t.Fatalf("%s error = %v", name, err)
		}
	}
}
