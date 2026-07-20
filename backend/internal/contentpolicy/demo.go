package contentpolicy

import (
	"fmt"
	"strings"
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

func DemoEligibleWorkSQL(alias string) string {
	for _, character := range alias {
		if (character < 'a' || character > 'z') && character != '_' {
			panic(fmt.Sprintf("invalid SQL alias %q", alias))
		}
	}
	return alias + `.is_permanently_free = 1 AND LOWER(TRIM(` + alias + `.age_rating)) IN (` +
		`'general', 'all age', 'all ages', 'all-age', 'all-ages', 'all_age', 'all_ages', '全年龄', '全年齢')`
}
