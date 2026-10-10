// Package workcode defines which strings identify a work. Every component that
// discovers, stores, or addresses a work by code shares this definition, so a
// code one of them accepts is never rejected by another.
//
// A work code is not a promise that a metadata provider knows the work: each
// provider keeps its own, possibly narrower, rule for the codes it can look up.
package workcode

import (
	"regexp"
	"strings"
)

// prefixes are the catalog prefixes that identify a work.
var prefixes = []string{"RJ", "BJ", "VJ", "CC"}

// PrefixAlternation is the regular-expression alternation of every work-code
// prefix, for callers that embed a work code in a larger pattern.
var PrefixAlternation = strings.Join(prefixes, "|")

// Digits is the regular-expression fragment for the numeric part of a code.
const Digits = `[0-9]{5,8}`

var exactPattern = regexp.MustCompile(`^(?:` + PrefixAlternation + `)` + Digits + `$`)

// Prefixes returns the catalog prefixes that identify a work.
func Prefixes() []string {
	return append([]string(nil), prefixes...)
}

// Normalize returns the canonical upper-case form of a work code, or "" when
// the value is not exactly one work code.
func Normalize(value string) string {
	code := strings.ToUpper(strings.TrimSpace(value))
	if !exactPattern.MatchString(code) {
		return ""
	}
	return code
}

// Valid reports whether the value is exactly one work code in any letter case.
func Valid(value string) bool {
	return Normalize(value) != ""
}
