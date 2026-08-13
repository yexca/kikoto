package library

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestValidateRecommendationConfigProtectsDiscoveryMix(t *testing.T) {
	if err := ValidateRecommendationConfig(DefaultRecommendationConfig()); err != nil {
		t.Fatalf("default recommendation config is invalid: %v", err)
	}

	withoutUnmarked := DefaultRecommendationConfig()
	withoutUnmarked.UnmarkedSlots = 0
	if err := ValidateRecommendationConfig(withoutUnmarked); err == nil {
		t.Fatal("recommendation config without Unmarked slots was accepted")
	}

	oversized := DefaultRecommendationConfig()
	oversized.UnmarkedSlots = 100
	if err := ValidateRecommendationConfig(oversized); err == nil {
		t.Fatal("recommendation config with more than 100 total slots was accepted")
	}
}

func TestRecommendationSeededHashMatchesSQLiteExpression(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	for _, test := range []struct {
		workID int64
		seed   int64
	}{
		{workID: 1, seed: 1},
		{workID: 42, seed: 9127},
		{workID: 2147483646, seed: -99},
		{workID: 9223372036854775807, seed: 2147483646},
	} {
		var fromSQLite int64
		if err := db.QueryRow("SELECT "+seededHashExpression("?", test.seed), test.workID).Scan(&fromSQLite); err != nil {
			t.Fatal(err)
		}
		if expected := recommendationSeededHash(test.workID, test.seed); fromSQLite != expected {
			t.Fatalf("seeded hash for work %d seed %d = %d, want %d", test.workID, test.seed, fromSQLite, expected)
		}
	}
}
