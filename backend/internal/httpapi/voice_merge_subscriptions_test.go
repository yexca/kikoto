package httpapi

import (
	"context"
	"testing"
)

// A voice actor merge keeps each account's subscription on the target with
// both seen sets, and Undo returns the source's subscriptions and seen set.
func TestVoiceMergeMovesSubscriptionsAndUndoRestoresThem(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO user_account (id, username, role) VALUES (1, 'subscriber-one', 'user'), (2, 'subscriber-two', 'user')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice 1', 'example voice 1'), (2, 'Example Voice 2', 'example voice 2')",
		"INSERT INTO person_alias (person_id, alias, source) VALUES (1, 'Example Voice 1', 'primary_name'), (2, 'Example Voice 2', 'primary_name')",
		"INSERT INTO creator_subscription (user_id, subject_kind, person_id, activated_at) VALUES (1, 'voice', 1, '2026-01-01 00:00:00'), (1, 'voice', 2, NULL), (2, 'voice', 2, '2026-01-02 00:00:00')",
		"INSERT INTO person_release_seen (person_id, primary_code) VALUES (1, 'RJ00000001'), (2, 'RJ00000002')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{db: db}
	ctx := context.Background()
	merged, err := server.mergeVoicePeople(ctx, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	count := func(query string) int {
		t.Helper()
		var value int
		if err := db.QueryRow(query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got := count("SELECT COUNT(*) FROM creator_subscription WHERE person_id = 1 AND activated_at IS NOT NULL"); got != 2 {
		t.Fatalf("active target subscriptions after merge = %d, want 2", got)
	}
	if got := count("SELECT COUNT(*) FROM person_release_seen WHERE person_id = 1"); got != 2 {
		t.Fatalf("target seen codes after merge = %d, want 2", got)
	}
	if _, err := server.undoVoiceMerge(ctx, 1, merged["mergeId"].(int64)); err != nil {
		t.Fatal(err)
	}
	if got := count("SELECT COUNT(*) FROM creator_subscription WHERE person_id = 2"); got != 2 {
		t.Fatalf("source subscriptions after undo = %d, want 2", got)
	}
	if got := count("SELECT COUNT(*) FROM creator_subscription WHERE person_id = 1"); got != 1 {
		t.Fatalf("target subscriptions after undo = %d, want 1", got)
	}
	if got := count("SELECT COUNT(*) FROM person_release_seen WHERE person_id = 2 AND primary_code = 'RJ00000002'"); got != 1 {
		t.Fatal("undo restores the source seen set")
	}
}
