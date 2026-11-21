// Package naturalorder orders file and folder names the way a listener reads
// them, the same order the client lists them in: a run of digits compares by
// its value, case, accents, and width are ignored, and a kanji numeral after 第
// compares as the number it writes, so 第二話 comes before 第十話.
package naturalorder

import (
	"regexp"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// collators holds collators for reuse, because a collator is not safe for
// concurrent use.
var collators = sync.Pool{New: func() any {
	return collate.New(language.Und, collate.Loose, collate.Numeric)
}}

var kanjiOrdinalPattern = regexp.MustCompile(`第([〇零一二三四五六七八九十百千万萬]+)`)

var kanjiDigitValues = map[rune]int{
	'〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}

var kanjiUnitValues = map[rune]int{'十': 10, '百': 100, '千': 1000}

// Compare compares two names in natural order; names that read the same fall
// back to their own text.
func Compare(left string, right string) int {
	collator := collators.Get().(*collate.Collator)
	defer collators.Put(collator)
	if result := collator.CompareString(naturalSortKey(left), naturalSortKey(right)); result != 0 {
		return result
	}
	return collator.CompareString(left, right)
}

// Key returns a byte string whose byte order is the natural order of names,
// for storing and ordering by in a database. Names that read the same have
// the same key; a caller orders them by their own text. A key depends on the
// collation tables, so a stored key is recomputed when KeyVersion changes.
func Key(name string) []byte {
	collator := collators.Get().(*collate.Collator)
	defer collators.Put(collator)
	var buffer collate.Buffer
	return append([]byte(nil), collator.KeyFromString(&buffer, naturalSortKey(name))...)
}

// KeyVersion names the collation Key computes; it changes whenever a Key
// result may change, such as after a collation table update.
const KeyVersion = 1

func naturalSortKey(name string) string {
	if !strings.Contains(name, "第") {
		return name
	}
	return kanjiOrdinalPattern.ReplaceAllStringFunc(name, func(ordinal string) string {
		value, ok := kanjiNumeralValue(strings.TrimPrefix(ordinal, "第"))
		if !ok {
			return ordinal
		}
		return "第" + value
	})
}

// kanjiNumeralValue returns the number a kanji numeral writes, such as 二十一
// or 二〇二四, in decimal digits, or false when it is not well formed.
func kanjiNumeralValue(numeral string) (string, bool) {
	characters := []rune(numeral)
	allDigits := true
	for _, character := range characters {
		if _, ok := kanjiDigitValues[character]; !ok {
			allDigits = false
			break
		}
	}
	if allDigits {
		var digits strings.Builder
		for _, character := range characters {
			digits.WriteString(strconv.Itoa(kanjiDigitValues[character]))
		}
		// Read as a number, so 〇一 is 1.
		value, err := strconv.ParseFloat(digits.String(), 64)
		if err != nil {
			return "", false
		}
		return strconv.FormatFloat(value, 'f', -1, 64), true
	}
	total, section, digit, hasDigit := 0, 0, 0, false
	for _, character := range characters {
		switch {
		case character == '〇' || character == '零':
			// A zero between units only marks a skipped place, as in 一百零五.
			if hasDigit {
				return "", false
			}
		case kanjiDigitValues[character] > 0:
			if hasDigit {
				return "", false
			}
			digit, hasDigit = kanjiDigitValues[character], true
		case kanjiUnitValues[character] > 0:
			if !hasDigit {
				digit = 1
			}
			section += digit * kanjiUnitValues[character]
			digit, hasDigit = 0, false
		default:
			multiplier := section + digit
			if multiplier == 0 {
				multiplier = 1
			}
			total += multiplier * 10000
			section, digit, hasDigit = 0, 0, false
		}
	}
	return strconv.Itoa(total + section + digit), true
}
