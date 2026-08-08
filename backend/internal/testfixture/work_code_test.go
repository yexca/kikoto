package testfixture

import "testing"

func TestWorkCodeUsesReservedPrefixRanges(t *testing.T) {
	tests := []struct {
		prefix WorkCodePrefix
		want   string
	}{
		{prefix: PrefixRJ, want: "RJ00000007"},
		{prefix: PrefixBJ, want: "BJ00000007"},
		{prefix: PrefixVJ, want: "VJ00000007"},
		{prefix: PrefixCC, want: "CC00000007"},
	}
	for _, test := range tests {
		if got := WorkCode(test.prefix, 7); got != test.want {
			t.Fatalf("WorkCode(%q, 7) = %q, want %q", test.prefix, got, test.want)
		}
	}
}

func TestWorkCodeAtSpansReservedPrefixRanges(t *testing.T) {
	tests := map[int]string{
		0:   "RJ00000000",
		99:  "RJ00000099",
		100: "BJ00000000",
		399: "CC00000099",
	}
	for index, want := range tests {
		if got := WorkCodeAt(index); got != want {
			t.Fatalf("WorkCodeAt(%d) = %q, want %q", index, got, want)
		}
	}
}

func TestWorkCodeRejectsValuesOutsideReservedRanges(t *testing.T) {
	for _, call := range []func(){
		func() { WorkCode("ZZ", 0) },
		func() { WorkCode(PrefixRJ, -1) },
		func() { WorkCode(PrefixRJ, 100) },
		func() { WorkCodeAt(400) },
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Fatal("synthetic work-code constructor did not panic")
				}
			}()
			call()
		}()
	}
}
