package httpapi

import (
	"context"
	"database/sql"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func resolveTestVoice(t *testing.T, db *sqlutil.DB, providerID int64, externalID string) int64 {
	t.Helper()
	ctx := context.Background()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	provider := sql.NullInt64{Int64: providerID, Valid: providerID > 0}
	personID, err := upsertPersonIdentity(ctx, tx, voiceCreditTarget{}, "Example Voice", provider, externalID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return personID
}

// A provider voice actor id seen for the first time never binds to a person
// of the same name who already carries another id of that provider: it is a
// different voice actor, and gets a person of its own under the same name.
func TestVoiceIdentityKeepsNamesakesWithDifferentProviderIDsApart(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO metadata_provider (id, code, display_name) VALUES (11, 'kikoeru_source_example_remote', 'Example Remote')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice', 'example voice')",
		"INSERT INTO person_alias (person_id, alias, source) VALUES (1, 'Example Voice', 'primary_name')",
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) VALUES (1, 11, 'voice_actor_id', 'voice-0001', 1)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	if got := resolveTestVoice(t, db, 11, "voice-0001"); got != 1 {
		t.Fatalf("the known id resolved to person %d, want 1", got)
	}
	namesake := resolveTestVoice(t, db, 11, "voice-0002")
	if namesake == 1 {
		t.Fatal("a new id of the same provider was bound to the namesake who carries another id")
	}
	if again := resolveTestVoice(t, db, 11, "voice-0002"); again != namesake {
		t.Fatalf("the new id resolved to person %d the second time, want %d", again, namesake)
	}
	var displayName string
	var aliases int
	if err := db.QueryRow("SELECT display_name, (SELECT COUNT(*) FROM person_alias WHERE person_id = person.id AND alias <> 'Example Voice') FROM person WHERE id = ?", namesake).Scan(&displayName, &aliases); err != nil {
		t.Fatal(err)
	}
	if displayName != "Example Voice" || aliases != 0 {
		t.Fatalf("namesake person = %q with %d other aliases, want the plain name and no other alias", displayName, aliases)
	}
	// The first person keeps its name and its own id.
	if again := resolveTestVoice(t, db, 11, "voice-0001"); again != 1 {
		t.Fatalf("the first id resolved to person %d after its namesake appeared", again)
	}
}

// A credit without a provider id names a voice actor credited by name. When
// several people share the name it never goes to one a provider id
// identifies: it goes to the one without an id, or to a new person with the
// plain name that later credits of the name reuse.
func TestVoiceCreditWithoutAnIDNeverPicksAnIdentifiedNamesake(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO metadata_provider (id, code, display_name) VALUES (11, 'kikoeru_source_example_remote', 'Example Remote')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice', 'example voice'), (2, 'Example Voice', 'example voice')",
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) VALUES (1, 11, 'voice_actor_id', 'voice-0001', 1), (2, 11, 'voice-0002', 'voice-0002', 1)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("UPDATE person_external_id SET id_type = 'voice_actor_id' WHERE person_id = 2"); err != nil {
		t.Fatal(err)
	}
	nameOnly := resolveTestVoice(t, db, 0, "")
	if nameOnly == 1 || nameOnly == 2 {
		t.Fatalf("a credit without an id went to identified person %d", nameOnly)
	}
	if again := resolveTestVoice(t, db, 0, ""); again != nameOnly {
		t.Fatalf("a later credit of the name went to person %d, want the name-only person %d", again, nameOnly)
	}
	// The person made for the ambiguous name never takes an id: a new id
	// gets a person of its own, and a known id's projection absorbs nothing.
	if got := resolveTestVoice(t, db, 11, "voice-0003"); got == nameOnly || got == 1 || got == 2 {
		t.Fatalf("a new id went to person %d, want a person of its own", got)
	}
	execFetchTestStatements(t, db,
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000019', 'Example Work')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, "+strconv.FormatInt(nameOnly, 10)+", 'voice_actor', 'metadata_snapshot')",
	)
	if got := resolveTestVoice(t, db, 11, "voice-0001"); got != 1 {
		t.Fatalf("the known id resolved to person %d, want 1", got)
	}
	var kept, moved int
	if err := db.QueryRow("SELECT (SELECT COUNT(*) FROM person WHERE id = ?), (SELECT COUNT(*) FROM work_credit WHERE person_id = 1)", nameOnly).Scan(&kept, &moved); err != nil {
		t.Fatal(err)
	}
	if kept != 1 || moved != 0 {
		t.Fatalf("the ambiguous-name person was merged: kept=%d credits moved=%d", kept, moved)
	}
}

// A known id never absorbs a namesake while another namesake carries an id of
// the same provider, since the name may stand for either of them.
func TestVoiceIdentityMergesNoNamesakeBesideAnotherIdentifiedOne(t *testing.T) {
	db := openMigratedTestDB(t)
	execFetchTestStatements(t, db,
		"INSERT INTO metadata_provider (id, code, display_name) VALUES (11, 'kikoeru_source_example_remote', 'Example Remote')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice', 'example voice'), (2, 'Example Voice', 'example voice'), (3, 'Example Voice', 'example voice')",
		"INSERT INTO person_external_id (person_id, provider_id, id_type, external_id, is_primary) VALUES (1, 11, 'voice_actor_id', 'voice-0001', 1), (2, 11, 'voice_actor_id', 'voice-0002', 1)",
	)
	if got := resolveTestVoice(t, db, 11, "voice-0001"); got != 1 {
		t.Fatalf("the known id resolved to person %d, want 1", got)
	}
	var people int
	if err := db.QueryRow("SELECT COUNT(*) FROM person").Scan(&people); err != nil || people != 3 {
		t.Fatalf("people after projection = %d, %v; want no merge", people, err)
	}
}

// A work whose credited voice actors share a name links that name to none of
// them rather than to a guess.
func TestVoiceLinkByNameRefusesAnAmbiguousName(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000017', 'Example Work')",
		"INSERT INTO person (id, display_name, sort_name) VALUES (1, 'Example Voice', 'example voice'), (2, 'Example Voice', 'example voice'), (3, 'Other Voice', 'other voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'metadata_snapshot'), (1, 2, 'voice_actor', 'metadata_snapshot'), (1, 3, 'voice_actor', 'metadata_snapshot')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := &Server{db: db}
	// An ambiguous name links to none and asks no provider: this server has
	// none to ask, so a request would fail.
	resolution, stage, err := server.resolveWorkEntityLinkRoute(context.Background(), "RJ00000017", workEntityLinkRequest{Kind: "voice", Name: "Example Voice"}, true)
	if err != nil || stage != "" || resolution.Route != "" || resolution.Fetched {
		t.Fatalf("ambiguous name link = %+v %q, %v; want none without a provider request", resolution, stage, err)
	}
	link, err := server.findWorkEntityRoute(context.Background(), "RJ00000017", workEntityLinkRequest{Kind: "voice", Name: "Other Voice"})
	if err != nil || link != "/voices/local-3" {
		t.Fatalf("unique name link = %q, %v", link, err)
	}
}
