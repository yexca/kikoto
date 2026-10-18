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

// Canonical returns the shared name of a known rating ("general", "r15", or
// "adult"), or "" for an empty or unknown value.
func Canonical(value string) string {
	if aliases := Aliases(value); len(aliases) > 0 {
		switch aliases[0] {
		case "adult":
			return "adult"
		case "r15":
			return "r15"
		default:
			return "general"
		}
	}
	return ""
}

// Strictness orders known ratings from general (1) to adult (3); an unknown
// value is 0.
func Strictness(value string) int {
	switch Canonical(value) {
	case "adult":
		return 3
	case "r15":
		return 2
	case "general":
		return 1
	}
	return 0
}

// Effective combines a provider rating with a manual one. The manual rating
// stands in for a missing or unknown provider rating; when both are known the
// stricter wins, so a manual value never relaxes the provider's.
func Effective(provider, manual string) string {
	if Strictness(manual) == 0 {
		return provider
	}
	if Strictness(provider) > Strictness(manual) {
		return Canonical(provider)
	}
	return Canonical(manual)
}
