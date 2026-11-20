package contentpolicy

import (
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

func TestIsAllAges(t *testing.T) {
	for _, value := range []string{"general", "All Ages", "全年齢", "全年龄"} {
		if !IsAllAges(value) {
			t.Fatalf("IsAllAges(%q) = false", value)
		}
	}
	for _, value := range []string{"", "adult", "r15"} {
		if IsAllAges(value) {
			t.Fatalf("IsAllAges(%q) = true", value)
		}
	}
}

// Demo admits a work by the effective rating Library and work detail show, so
// a manual rating can make a work eligible or exclude it.
func TestDemoEligibleWorkSQLUsesTheEffectiveAgeRating(t *testing.T) {
	db := storagetest.Open(t)
	works := []struct {
		code     string
		provider string
		manual   string
		free     int
		eligible bool
	}{
		{code: "RJ00000000", provider: "general", free: 1, eligible: true},
		{code: "RJ00000001", provider: "general", manual: "adult", free: 1},
		{code: "RJ00000002", provider: "", manual: "general", free: 1, eligible: true},
		{code: "RJ00000003", provider: "adult", manual: "general", free: 1},
		{code: "RJ00000004", provider: "All Ages", manual: "r15", free: 1},
		{code: "RJ00000005", provider: "general", manual: "general", free: 0},
	}
	for _, work := range works {
		result, err := db.Exec(`INSERT INTO work (primary_code, title, age_rating, is_permanently_free) VALUES (?, 'Example Work', ?, ?)`,
			work.code, work.provider, work.free)
		if err != nil {
			t.Fatal(err)
		}
		if work.manual == "" {
			continue
		}
		id, err := result.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO work_manual_override (work_id, field_name, value_json) VALUES (?, 'age_rating', json_quote(?))`, id, work.manual); err != nil {
			t.Fatal(err)
		}
	}
	for _, work := range works {
		var eligible bool
		if err := db.QueryRow(`SELECT `+DemoEligibleWorkSQL("demo_work")+` FROM work AS demo_work WHERE demo_work.primary_code = ?`, work.code).Scan(&eligible); err != nil {
			t.Fatal(err)
		}
		if eligible != work.eligible {
			t.Errorf("%s (provider %q, manual %q) eligible = %t, want %t", work.code, work.provider, work.manual, eligible, work.eligible)
		}
	}
}
