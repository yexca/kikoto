package sqlutil

import (
	"fmt"
	"strings"
)

// Int64InQuery fills the %s of format with one placeholder per value and
// returns the values as arguments, exactly as given. No values leave the list
// empty.
func Int64InQuery(format string, values []int64) (string, []any) {
	args := make([]any, len(values))
	for index, value := range values {
		args[index] = value
	}
	return fmt.Sprintf(format, strings.TrimSuffix(strings.Repeat("?,", len(values)), ",")), args
}

// UniquePositiveInt64InQuery is Int64InQuery over UniquePositiveInt64s(values).
// When no id remains, the list is NULL.
func UniquePositiveInt64InQuery(format string, values []int64) (string, []any) {
	values = UniquePositiveInt64s(values)
	if len(values) == 0 {
		return fmt.Sprintf(format, "NULL"), []any{}
	}
	return Int64InQuery(format, values)
}

// UniquePositiveInt64s drops non-positive and repeated ids, keeping first-seen
// order. It never returns nil.
func UniquePositiveInt64s(values []int64) []int64 {
	result := make([]int64, 0, len(values))
	seen := map[int64]bool{}
	for _, value := range values {
		if value <= 0 || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}
