package agerating

import "testing"

func TestEffectiveNeverRelaxesProviderRating(t *testing.T) {
	cases := []struct{ provider, manual, want string }{
		{"", "general", "general"},
		{"unrated", "R18", "adult"},
		{"general", "r15", "r15"},
		{"adult", "general", "adult"},
		{"adult", "", "adult"},
		{"", "", ""},
		{"general", "unrated", "general"},
	}
	for _, c := range cases {
		if got := Effective(c.provider, c.manual); got != c.want {
			t.Fatalf("Effective(%q, %q) = %q, want %q", c.provider, c.manual, got, c.want)
		}
	}
}
