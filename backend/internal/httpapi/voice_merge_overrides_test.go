package httpapi

import (
	"context"
	"testing"
)

// A manual voice actor list keeps naming the same voice actor through a merge:
// the merged-away person's id becomes the kept person's, and Undo puts the
// list back.
func TestVoiceMergeRewritesManualVoiceActorListsAndUndoRestoresThem(t *testing.T) {
	db := openMigratedTestDB(t)
	const before = `[{"name":"Example Voice 2","personId":2},{"name":"Example Voice 3","personId":3}]`
	for _, statement := range []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Example Work 1'), (2, 'RJ00000002', 'Example Work 2')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice 1', 'example voice 1'), (2, 'Example Voice 2', 'example voice 2'), (3, 'Example Voice 3', 'example voice 3')",
		"INSERT INTO person_alias (person_id, alias, source) VALUES (1, 'Example Voice 1', 'primary_name'), (2, 'Example Voice 2', 'primary_name'), (3, 'Example Voice 3', 'primary_name')",
		"INSERT INTO work_manual_override (work_id, field_name, value_json) VALUES (1, 'voice_actors', '" + before + "')",
		`INSERT INTO work_manual_override (work_id, field_name, value_json) VALUES (2, 'voice_actors', '[{"name":"Example Voice 1","personId":1},{"name":"Example Voice 2","personId":2}]')`,
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
	override := func(workID int) string {
		t.Helper()
		var value string
		if err := db.QueryRow("SELECT value_json FROM work_manual_override WHERE work_id = ? AND field_name = 'voice_actors'", workID).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got, want := override(1), `[{"name":"Example Voice 2","personId":1},{"name":"Example Voice 3","personId":3}]`; got != want {
		t.Fatalf("merged list = %s, want %s", got, want)
	}
	if got, want := override(2), `[{"name":"Example Voice 1","personId":1}]`; got != want {
		t.Fatalf("list naming both = %s, want %s", got, want)
	}
	if _, err := server.undoVoiceMerge(ctx, 1, merged["mergeId"].(int64)); err != nil {
		t.Fatal(err)
	}
	if got := override(1); got != before {
		t.Fatalf("list after undo = %s, want %s", got, before)
	}
}

// Undo leaves a manual voice actor list edited since the merge as the editor
// left it, and the restored person keeps no manual credit that list no longer
// gives them.
func TestVoiceMergeUndoKeepsAnEditedListAndItsCredits(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Example Work 1')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice 1', 'example voice 1'), (2, 'Example Voice 2', 'example voice 2'), (3, 'Example Voice 3', 'example voice 3')",
		"INSERT INTO person_alias (person_id, alias, source) VALUES (1, 'Example Voice 1', 'primary_name'), (2, 'Example Voice 2', 'primary_name'), (3, 'Example Voice 3', 'primary_name')",
		`INSERT INTO work_manual_override (work_id, field_name, value_json) VALUES (1, 'voice_actors', '[{"name":"Example Voice 2","personId":2}]')`,
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 2, 'voice_actor', 'manual_override')",
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
	const edited = `[{"name":"Example Voice 3","personId":3}]`
	if _, err := db.Exec("UPDATE work_manual_override SET value_json = ? WHERE work_id = 1", edited); err != nil {
		t.Fatal(err)
	}
	if _, err := server.undoVoiceMerge(ctx, 1, merged["mergeId"].(int64)); err != nil {
		t.Fatal(err)
	}
	var list string
	var credits int
	if err := db.QueryRow("SELECT value_json FROM work_manual_override WHERE work_id = 1").Scan(&list); err != nil || list != edited {
		t.Fatalf("edited list after undo = %s, %v", list, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work_credit WHERE work_id = 1 AND person_id = 2 AND source = 'manual_override'").Scan(&credits); err != nil || credits != 0 {
		t.Fatalf("manual credits of the restored person = %d, %v; the edited list no longer names them", credits, err)
	}
}
