package sqlutil

import (
	"slices"
	"testing"
)

// The two builders differ in which ids they bind and in the empty list, which
// changes what NOT IN matches.
func TestInQueryBuildersBindTheirOwnIDs(t *testing.T) {
	values := []int64{2, 0, 2, -1, 1}
	cases := []struct {
		name  string
		build func(string, []int64) (string, []any)
		input []int64
		query string
		args  []any
	}{
		{"as given", Int64InQuery, values, "id IN (?,?,?,?,?)", []any{int64(2), int64(0), int64(2), int64(-1), int64(1)}},
		{"as given, empty", Int64InQuery, nil, "id IN ()", []any{}},
		{"unique positive", UniquePositiveInt64InQuery, values, "id IN (?,?)", []any{int64(2), int64(1)}},
		{"unique positive, empty", UniquePositiveInt64InQuery, []int64{0}, "id IN (NULL)", []any{}},
	}
	for _, check := range cases {
		query, args := check.build("id IN (%s)", check.input)
		if query != check.query || !slices.Equal(args, check.args) {
			t.Errorf("%s = %q %v", check.name, query, args)
		}
	}
}
