// Package agerating gives provider age ratings one shared search vocabulary.
package agerating

import "strings"

var groups = [][]string{
	{"adult", "r18", "r-18", "18"},
	{"r15", "r-15", "15"},
	{"general", "all", "all age", "all ages", "all-age", "all-ages", "all_age", "all_ages", "全年齢", "全年龄", "全年齡"},
}

// Aliases returns the equivalent provider and display values for a known rating.
// Unknown values keep the existing substring-search behavior.
func Aliases(value string) []string {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, group := range groups {
		for _, alias := range group {
			if value == alias {
				return append([]string(nil), group...)
			}
		}
	}
	return nil
}

func Matches(value, query string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	query = strings.ToLower(strings.TrimSpace(query))
	if aliases := Aliases(query); len(aliases) > 0 {
		for _, alias := range aliases {
			if value == alias {
				return true
			}
		}
		return false
	}
	return strings.Contains(value, query)
}
