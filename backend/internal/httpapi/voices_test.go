package httpapi

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestLoadVoiceSummariesSerializesMissingUserTagsAsArray(t *testing.T) {
	db := openMigratedTestDB(t)
	statements := []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000001', 'Voice work')",
		"INSERT INTO person (id, display_name) VALUES (1, 'Example voice')",
		"INSERT INTO work_credit (work_id, person_id, role, source) VALUES (1, 1, 'voice_actor', 'test')",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}

	server := &Server{db: db}
	summaries, err := server.loadVoiceSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 || summaries[0].UserTags == nil {
		t.Fatalf("summaries = %+v, want one voice with non-nil userTags", summaries)
	}
	raw, err := json.Marshal(summaries)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"userTags":[]`) {
		t.Fatalf("JSON = %s, want empty userTags array", raw)
	}
}
