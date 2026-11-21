package storage

import (
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// Migration 101 makes the For you temperature a step from 1 to 5: a saved
// Safe, Balanced, or Adventurous becomes 1, 3, or 5, the default stays NULL,
// the account's other preferences are kept, and no other step is accepted.
func TestMigrationKeepsSavedForYouTemperatureAsStep(t *testing.T) {
	db := openMigratedThrough(t, 100)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'synthetic-safe', 'user'), (2, 'synthetic-balanced', 'user'), (3, 'synthetic-adventurous', 'user'), (4, 'synthetic-default', 'user')`,
		`INSERT INTO user_preference (user_id, for_you_temperature, time_zone) VALUES (1, 'safe', 'Etc/UTC'), (2, 'balanced', NULL), (3, 'adventurous', NULL), (4, NULL, NULL)`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := Migrate(db, copyNumberedMigrationsThrough(t, filepath.Join("..", "..", "migrations"), 101)); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query(`SELECT user_id, for_you_temperature, COALESCE(time_zone, '') FROM user_preference ORDER BY user_id`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	got := []string{}
	for rows.Next() {
		var userID int64
		var temperature sql.NullInt64
		var zone string
		if err := rows.Scan(&userID, &temperature, &zone); err != nil {
			t.Fatal(err)
		}
		got = append(got, fmt.Sprintf("%d:%v:%d:%s", userID, temperature.Valid, temperature.Int64, zone))
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if want := "1:true:1:Etc/UTC 2:true:3: 3:true:5: 4:false:0:"; strings.Join(got, " ") != want {
		t.Fatalf("preferences = %q, want %q", strings.Join(got, " "), want)
	}
	if _, err := db.Exec(`UPDATE user_preference SET for_you_temperature = 6 WHERE user_id = 4`); err == nil {
		t.Fatal("temperature 6 was accepted")
	}
}
