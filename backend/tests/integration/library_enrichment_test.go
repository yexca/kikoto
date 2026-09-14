package integration_test

import (
	"context"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
)

func TestLoadVoiceCreditsKeepsWorkOwnershipRoleAndOrder(t *testing.T) {
	db := openMigratedTestDB(t, "voice-credits.db")
	for _, statement := range []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work A'), (2, 'RJ00000001', 'Example Work B'), (3, 'RJ00000002', 'Example Work C')`,
		`INSERT INTO person (id, display_name) VALUES (1, 'Example Voice B'), (2, 'Example Voice A'), (3, 'Example Voice AB')`,
		`INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'manual'), (1, 3, 'voice_actor', 'manual'), (1, 2, 'voice_actor', 'manual'), (2, 1, 'writer', 'manual'), (3, 1, 'voice_actor', 'manual')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	credits, err := library.NewStore(db).LoadVoiceCredits(context.Background(), []int64{1, 2, 1})
	if err != nil {
		t.Fatal(err)
	}
	want := []library.VoiceCredit{{PersonID: 2, DisplayName: "Example Voice A"}, {PersonID: 3, DisplayName: "Example Voice AB"}, {PersonID: 1, DisplayName: "Example Voice B"}}
	if !reflect.DeepEqual(credits[1], want) || len(credits[2]) != 0 || len(credits[3]) != 0 {
		t.Fatalf("voice credit grouping = %+v", credits)
	}
}

func TestLoadMediaSelectionsPrefersAvailableLocalEdition(t *testing.T) {
	db := openMigratedTestDB(t, "selection.db")
	statements := []string{
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Origin'), (2, 'RJ00000001', 'Translation')`,
		`INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (1, 1, 'RJ00000000')`,
		`INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical, translation_kind) VALUES (1, 1, 'RJ00000000', 'RJ00000000', 1, 'origin'), (2, 1, 'RJ00000001', 'RJ00000000', 0, 'official')`,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Origin track'), (2, 2, 'audio', 'Local translated track')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 'remote_stream', 'origin.mp3', 'available'), (2, 2, 'local', 'translation.mp3', 'available')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	selections, err := library.NewStore(db).LoadMediaSelections(context.Background(), []int64{1})
	if err != nil {
		t.Fatal(err)
	}
	if got := selections[1]; got.WorkID != 2 || got.Code != "RJ00000001" || got.TranslationKind != "official" {
		t.Fatalf("selection = %+v", got)
	}
}
