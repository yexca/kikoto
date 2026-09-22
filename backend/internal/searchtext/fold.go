// Package searchtext owns the text normalization shared by persisted search
// documents and the query needles compared against them.
package searchtext

import (
	"database/sql/driver"
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
	"modernc.org/sqlite"
)

// SQLFoldFunction is the deterministic SQLite scalar function that applies
// Fold to a column value. It is registered on the process-wide SQLite driver
// so every connection opened by this binary can compare folded values.
const SQLFoldFunction = "kikoto_search_fold"

func init() {
	sqlite.MustRegisterDeterministicScalarFunction(SQLFoldFunction, 1, foldSQLValue)
}

// Fold returns the comparison form of search text. It applies NFKC so
// full-width Latin letters and digits match their ASCII forms and half-width
// katakana matches full-width katakana, lowercases with Unicode case mapping,
// maps katakana to hiragana so either script matches the other, and collapses
// whitespace and control characters to single spaces.
func Fold(value string) string {
	value = norm.NFKC.String(value)
	var builder strings.Builder
	builder.Grow(len(value))
	pendingSpace := false
	for _, r := range value {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			pendingSpace = builder.Len() > 0
			continue
		}
		if pendingSpace {
			builder.WriteByte(' ')
			pendingSpace = false
		}
		builder.WriteRune(foldRune(r))
	}
	return builder.String()
}

func foldRune(r rune) rune {
	switch {
	// Katakana ァ..ヶ and the iteration marks ヽ ヾ have hiragana counterparts
	// at a fixed 0x60 offset. The prolonged sound mark ー is shared by both
	// scripts and is left unchanged.
	case r >= 'ァ' && r <= 'ヶ', r == 'ヽ', r == 'ヾ':
		return r - 0x60
	default:
		return unicode.ToLower(r)
	}
}

func foldSQLValue(_ *sqlite.FunctionContext, args []driver.Value) (driver.Value, error) {
	switch value := args[0].(type) {
	case nil:
		return nil, nil
	case string:
		return Fold(value), nil
	case []byte:
		return Fold(string(value)), nil
	default:
		return Fold(fmt.Sprint(value)), nil
	}
}
