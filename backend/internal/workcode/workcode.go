// Package workcode defines which strings identify a work. Every component that
// discovers, stores, or addresses a work by code shares this definition, so a
// code one of them accepts is never rejected by another.
//
// A work code is not a promise that a metadata provider knows the work: each
// provider keeps its own, possibly narrower, rule for the codes it can look up.
package workcode

import (
	"fmt"
	"regexp"
	"strings"
)

// CustomPrefix is the prefix of the codes Kikoto assigns to custom works:
// local folders the library holds as works without a catalog code.
const CustomPrefix = "KT"

// CustomDigits is the number of digits of an assigned custom work code.
const CustomDigits = 8

// catalogPrefixes are the prefixes of the codes a store catalogs, which remote
// sources and folder names carry.
var catalogPrefixes = []string{"RJ", "BJ", "VJ", "CC"}

// CatalogPrefixAlternation is the regular-expression alternation of every
// catalog prefix, for callers that embed a catalog code in a larger pattern.
var CatalogPrefixAlternation = strings.Join(catalogPrefixes, "|")

// Digits is the regular-expression fragment for the numeric part of a
// catalog code.
const Digits = `[0-9]{5,8}`

// CustomDigitsPattern is the regular-expression fragment for the numeric part
// of a custom work code, which always has CustomDigits digits.
var CustomDigitsPattern = fmt.Sprintf(`[0-9]{%d}`, CustomDigits)

// ExactAlternation is the regular-expression fragment for exactly one work
// code, for callers that embed a work code in a larger pattern.
var ExactAlternation = `(?:(?:` + CatalogPrefixAlternation + `)` + Digits + `|` + CustomPrefix + CustomDigitsPattern + `)`

var (
	exactPattern   = regexp.MustCompile(`^` + ExactAlternation + `$`)
	catalogPattern = regexp.MustCompile(`^(?:` + CatalogPrefixAlternation + `)` + Digits + `$`)
)

// Prefixes returns the prefixes that identify a work, the custom prefix last.
func Prefixes() []string {
	return append(append([]string(nil), catalogPrefixes...), CustomPrefix)
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

// NormalizeCatalog returns the canonical upper-case form of a catalog code, or
// "" for anything else, including a custom work code. Use it for codes that
// come from a remote source: a custom work exists only in this library, so a
// remote code never addresses one.
func NormalizeCatalog(value string) string {
	code := strings.ToUpper(strings.TrimSpace(value))
	if !catalogPattern.MatchString(code) {
		return ""
	}
	return code
}

// Valid reports whether the value is exactly one work code in any letter case.
func Valid(value string) bool {
	return Normalize(value) != ""
}

// IsCustom reports whether the value is a custom work code.
func IsCustom(value string) bool {
	return strings.HasPrefix(Normalize(value), CustomPrefix)
}

// Custom returns the custom work code with the given positive number.
func Custom(number int64) string {
	return fmt.Sprintf("%s%0*d", CustomPrefix, CustomDigits, number)
}
