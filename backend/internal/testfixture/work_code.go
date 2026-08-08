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

func validWorkCodePrefix(prefix WorkCodePrefix) bool {
	for _, candidate := range workCodePrefixes {
		if prefix == candidate {
			return true
		}
	}
	return false
}
