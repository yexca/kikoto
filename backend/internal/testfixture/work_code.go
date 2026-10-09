package testfixture

import "fmt"

type WorkCodePrefix string

const (
	PrefixRJ WorkCodePrefix = "RJ"
	PrefixBJ WorkCodePrefix = "BJ"
	PrefixVJ WorkCodePrefix = "VJ"
	PrefixCC WorkCodePrefix = "CC"

	workCodesPerPrefix = 100
)

var workCodePrefixes = [...]WorkCodePrefix{PrefixRJ, PrefixBJ, PrefixVJ, PrefixCC}

func WorkCode(prefix WorkCodePrefix, ordinal int) string {
	if !validWorkCodePrefix(prefix) {
		panic(fmt.Sprintf("unsupported synthetic work-code prefix %q", prefix))
	}
	if ordinal < 0 || ordinal >= workCodesPerPrefix {
		panic(fmt.Sprintf("synthetic work-code ordinal %d is outside 0..99", ordinal))
	}
	return fmt.Sprintf("%s%08d", prefix, ordinal)
}

func WorkCodeAt(index int) string {
	if index < 0 || index >= len(workCodePrefixes)*workCodesPerPrefix {
		panic(fmt.Sprintf("synthetic work-code index %d is outside 0..399", index))
	}
	return WorkCode(workCodePrefixes[index/workCodesPerPrefix], index%workCodesPerPrefix)
}

// HighCardinalityWorkCodeAt is reserved for isolated scale experiments which
// require more than the 400 identities supported by WorkCodeAt. Its four
// zero-prefixed ranges are deliberately bounded and never provider fixtures.
func HighCardinalityWorkCodeAt(index int) string {
	const perPrefix = 100000
	if index < 0 || index >= len(workCodePrefixes)*perPrefix {
		panic(fmt.Sprintf("synthetic scale work-code index %d is outside 0..399999", index))
	}
	return fmt.Sprintf("%s%08d", workCodePrefixes[index/perPrefix], index%perPrefix)
}

func validWorkCodePrefix(prefix WorkCodePrefix) bool {
	for _, candidate := range workCodePrefixes {
		if prefix == candidate {
			return true
		}
	}
	return false
}
