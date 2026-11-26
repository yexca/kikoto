package textvalue

import "testing"

// Callers rely on the two helpers disagreeing only about surrounding whitespace.
func TestFirstNonBlankKeepsOrTrimsSurroundingWhitespace(t *testing.T) {
	values := []string{"", " \t", "  first  ", "second"}
	if got := FirstNonBlankRaw(values...); got != "  first  " {
		t.Fatalf("FirstNonBlankRaw() = %q", got)
	}
	if got := FirstNonBlankTrimmed(values...); got != "first" {
		t.Fatalf("FirstNonBlankTrimmed() = %q", got)
	}
	if raw, trimmed := FirstNonBlankRaw(" ", ""), FirstNonBlankTrimmed(" ", ""); raw != "" || trimmed != "" {
		t.Fatalf("all blank = %q, %q", raw, trimmed)
	}
}
