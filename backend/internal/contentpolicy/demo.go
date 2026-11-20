package contentpolicy

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/agerating"
)

var allAgesRatings = map[string]bool{
	"all age":  true,
	"all ages": true,
	"all-age":  true,
	"all-ages": true,
	"all_age":  true,
	"all_ages": true,
	"general":  true,
	"全年龄":      true,
	"全年齢":      true,
}

func IsAllAges(ageRating string) bool {
	return allAgesRatings[strings.ToLower(strings.TrimSpace(ageRating))]
}

// DemoEligibleWorkSQL matches a permanently free work whose effective age
// rating, agerating.Effective of its provider and manual ratings, is all-ages.
// Without a known manual rating the provider rating must be all-ages; a manual
// general rating applies unless the provider rating is stricter; a stricter
// manual rating never qualifies.
func DemoEligibleWorkSQL(alias string) string {
	for _, character := range alias {
		if (character < 'a' || character > 'z') && character != '_' {
			panic(fmt.Sprintf("invalid SQL alias %q", alias))
		}
	}
	manual := `COALESCE((SELECT ` + ageStrictnessSQL(`json_extract(`+alias+`_manual_age.value_json, '$')`) + `
		FROM work_manual_override AS ` + alias + `_manual_age
		WHERE ` + alias + `_manual_age.work_id = ` + alias + `.id AND ` + alias + `_manual_age.field_name = 'age_rating'
			AND ` + alias + `_manual_age.language = ''), 0)`
	return alias + `.is_permanently_free = 1 AND (CASE ` + manual + `
		WHEN 0 THEN LOWER(TRIM(` + alias + `.age_rating)) IN (` +
		`'general', 'all age', 'all ages', 'all-age', 'all-ages', 'all_age', 'all_ages', '全年龄', '全年齢')
		WHEN 1 THEN ` + ageStrictnessSQL(alias+".age_rating") + ` <= 1
		ELSE 0 END)`
}

// ageStrictnessSQL is agerating.Strictness of an SQL expression. The aliases
// are fixed literals.
func ageStrictnessSQL(expression string) string {
	value := `LOWER(TRIM(COALESCE(` + expression + `, '')))`
	clause := `(CASE`
	for strictness, rating := range []string{"general", "r15", "adult"} {
		clause += ` WHEN ` + value + ` IN ('` + strings.Join(agerating.Aliases(rating), `','`) + `') THEN ` + strconv.Itoa(strictness+1)
	}
	return clause + ` ELSE 0 END)`
}
