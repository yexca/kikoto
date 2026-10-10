package workcode

import (
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestNormalizeAcceptsEveryWorkPrefix(t *testing.T) {
	for _, prefix := range []testfixture.WorkCodePrefix{
		testfixture.PrefixRJ,
		testfixture.PrefixBJ,
		testfixture.PrefixVJ,
		testfixture.PrefixCC,
	} {
		code := testfixture.WorkCode(prefix, 0)
		if got := Normalize(" " + strings.ToLower(code) + " "); got != code {
			t.Fatalf("Normalize(%q) = %q, want %q", code, got, code)
		}
	}
}

func TestNormalizeRejectsValuesThatAreNotOneCode(t *testing.T) {
	for _, value := range []string{
		"",
		"RJ0000",
		"RJ000000000",
		"RJ0000000A",
		"XX00000000",
		"RJ00000000 RJ00000001",
		"../RJ00000000",
	} {
		if got := Normalize(value); got != "" {
			t.Fatalf("Normalize(%q) = %q, want empty", value, got)
		}
	}
}
