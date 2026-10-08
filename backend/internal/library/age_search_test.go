package library

import "testing"

func TestAgeSearchMatchesDisplayAndProviderAliasesAcrossFamilies(t *testing.T) {
	db := openSearchTestDB(t, "../../migrations")
	ids := []int64{}
	for ordinal, age := range []string{"adult", "R-18", "general", "全年齢", "r15", "", "unknown"} {
		id := insertSearchWork(t, db, ordinal, "Example Work")
		execSearchFixture(t, db, "UPDATE work SET age_rating=? WHERE id=?", age, id)
		ids = append(ids, id)
	}
	// Only a sibling knows the rating; the canonical work must still match.
	searchEditionFamily(t, db, []int{5, 1}, ids[5], ids[1])
	store := NewStore(db)
	for _, query := range []string{"age:R18", "age:adult", "age:18"} {
		assertSearchCodes(t, store, 0, query, 0, 5)
	}
	for _, query := range []string{"age:general", "age:all", "age:全年齢", "age:全年龄", "age:全年齡", `age:"all ages"`} {
		assertSearchCodes(t, store, 0, query, 2, 3)
	}
	assertSearchCodes(t, store, 0, "age:R-15", 4)
	assertSearchCodes(t, store, 0, "age:unknown", 6)
}
