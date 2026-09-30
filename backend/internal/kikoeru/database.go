package kikoeru

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

var (
	// ErrDatabaseInvalid means the file is not a readable Kikoeru SQLite
	// database with a review table.
	ErrDatabaseInvalid = errors.New("kikoeru database is invalid")
	// ErrDatabaseUserNotFound means the database has no such account.
	ErrDatabaseUserNotFound = errors.New("kikoeru database user was not found")
)

const maxDatabaseReviewTextRunes = 20000

var sqliteHeader = []byte("SQLite format 3\x00")

// ReadDatabaseReviews reads one account's reviews from an uploaded Kikoeru
// SQLite database. The file is untrusted: it is opened read-only and
// immutable with an untrusted schema, only the base review table is queried,
// and the row count and text length are bounded. Other accounts' rows and the
// user table's password hashes are never read.
func ReadDatabaseReviews(ctx context.Context, path, userName string, maxItems int) ([]AccountReview, error) {
	if err := checkSQLiteHeader(path); err != nil {
		return nil, err
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	query := url.Values{}
	query.Set("mode", "ro")
	query.Set("immutable", "1")
	query.Add("_pragma", "query_only(1)")
	query.Add("_pragma", "trusted_schema(0)")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(absolute)+"?"+query.Encode())
	if err != nil {
		return nil, ErrDatabaseInvalid
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)

	columns, err := tableColumns(ctx, db, "t_review")
	if err != nil {
		return nil, err
	}
	if !columns["user_name"] || !columns["work_id"] {
		return nil, ErrDatabaseInvalid
	}
	// Column names come from this fixed list, never from the file.
	selectColumn := func(name, expression string) string {
		if columns[name] {
			return expression
		}
		return "NULL"
	}
	statement := "SELECT CAST(work_id AS TEXT), " +
		selectColumn("progress", "CAST(progress AS TEXT)") + ", " +
		selectColumn("rating", "CAST(rating AS REAL)") + ", " +
		selectColumn("review_text", "substr(CAST(review_text AS TEXT), 1, "+strconv.Itoa(maxDatabaseReviewTextRunes)+")") +
		" FROM t_review WHERE user_name = ? LIMIT ?"
	rows, err := db.QueryContext(ctx, statement, userName, maxItems+1)
	if err != nil {
		return nil, databaseError(ctx, err)
	}
	defer func() { _ = rows.Close() }()
	var reviews []AccountReview
	for rows.Next() {
		var workID, progress, reviewText sql.NullString
		var rating sql.NullFloat64
		if err := rows.Scan(&workID, &progress, &rating, &reviewText); err != nil {
			return nil, databaseError(ctx, err)
		}
		if len(reviews) >= maxItems {
			return nil, ErrAccountLimit
		}
		id, _ := json.Marshal(workID.String)
		review := AccountReview{WorkID: id, Progress: progress.String, ReviewText: reviewText.String}
		if rating.Valid {
			encoded, _ := json.Marshal(rating.Float64)
			review.Rating = rawRating(encoded)
		}
		reviews = append(reviews, review)
	}
	if err := rows.Err(); err != nil {
		return nil, databaseError(ctx, err)
	}
	if len(reviews) == 0 {
		if exists, err := databaseUserExists(ctx, db, userName); err != nil {
			return nil, err
		} else if !exists {
			return nil, ErrDatabaseUserNotFound
		}
	}
	return reviews, nil
}

func checkSQLiteHeader(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	header := make([]byte, len(sqliteHeader))
	if _, err := io.ReadFull(file, header); err != nil || !bytes.Equal(header, sqliteHeader) {
		return ErrDatabaseInvalid
	}
	return nil
}

func tableColumns(ctx context.Context, db *sql.DB, table string) (map[string]bool, error) {
	var kind string
	if err := db.QueryRowContext(ctx, `SELECT type FROM sqlite_master WHERE name = ?`, table).Scan(&kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrDatabaseInvalid
		}
		return nil, databaseError(ctx, err)
	}
	// A view would run SQL defined by the file; only a base table is read.
	if kind != "table" {
		return nil, ErrDatabaseInvalid
	}
	rows, err := db.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, databaseError(ctx, err)
	}
	defer func() { _ = rows.Close() }()
	columns := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, databaseError(ctx, err)
		}
		columns[strings.ToLower(name)] = true
	}
	if err := rows.Err(); err != nil {
		return nil, databaseError(ctx, err)
	}
	return columns, nil
}

// databaseUserExists distinguishes an account without reviews from a mistyped
// name. Only the name column is read.
func databaseUserExists(ctx context.Context, db *sql.DB, userName string) (bool, error) {
	columns, err := tableColumns(ctx, db, "t_user")
	if errors.Is(err, ErrDatabaseInvalid) || (err == nil && !columns["name"]) {
		// Without a user table the database cannot say; treat the name as valid.
		return true, nil
	}
	if err != nil {
		return false, err
	}
	var found int
	err = db.QueryRowContext(ctx, `SELECT 1 FROM t_user WHERE name = ? LIMIT 1`, userName).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, databaseError(ctx, err)
	}
	return true, nil
}

func databaseError(ctx context.Context, err error) error {
	if ctxErr := ctx.Err(); ctxErr != nil {
		return ctxErr
	}
	return errors.Join(ErrDatabaseInvalid, err)
}
