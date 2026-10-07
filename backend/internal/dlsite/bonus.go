package dlsite

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// A purchase bonus (購入特典, 早期購入特典, 予約特典) is a hidden, free product
// that buyers of another product receive. DLsite declares no relationship
// between the two: the bonus has no translation, edition, or bonus field naming
// its parent, and its public page is not listed. These helpers recognize a
// bonus from its own payload and score candidate parents from the same maker.

var (
	bonusBracketPattern = regexp.MustCompile(`[【\[［〔(（]([^】\]］〕)）]{1,120})[】\]］〕)）]`)
	bonusQuotedPattern  = regexp.MustCompile(`[「『]([^」』]{1,80})[」』]`)
	englishBonusPattern = regexp.MustCompile(`(?i)\b(?:early[ -]?purchase|purchase|pre[ -]?order|reservation)\s+bonus\b`)
	// makerIDPattern bounds the provider-supplied maker id before it selects
	// a maker profile page.
	makerIDPattern = regexp.MustCompile(`^[A-Z]{2}[0-9]{1,12}$`)
)

// PurchaseBonusHint is what a bonus product says about its parent.
type PurchaseBonusHint struct {
	Code        string
	MakerID     string
	TitleKana   string
	ReleaseDate string
	// ParentName is the parent title quoted inside the bonus marker, for
	// example Example Work in 【「Example Work」早期購入特典】. It is
	// normalized and may be empty.
	ParentName string
}

// PurchaseBonusCandidate is a product from the bonus's maker that may be its
// parent, read from a fetched product or from stored metadata.
type PurchaseBonusCandidate struct {
	Code        string
	MakerID     string
	Title       string
	TitleKana   string
	ReleaseDate string
	Free        bool
}

// PurchaseBonusMatch ranks the evidence that a candidate is a bonus's parent.
// Higher values are stronger.
type PurchaseBonusMatch int

const (
	PurchaseBonusNoMatch PurchaseBonusMatch = iota
	// PurchaseBonusNameMatch: same release date and the quoted parent name
	// appears, in order, in the candidate title.
	PurchaseBonusNameMatch
	// PurchaseBonusKanaMatch: the bonus carries the candidate's title reading.
	PurchaseBonusKanaMatch
)

func (match PurchaseBonusMatch) String() string {
	switch match {
	case PurchaseBonusKanaMatch:
		return "title_kana"
	case PurchaseBonusNameMatch:
		return "release_date_and_name"
	default:
		return "none"
	}
}

// PurchaseBonusHintFor reports whether product is a purchase bonus and, if so,
// the hints it carries. A bonus must be permanently free and carry a bonus
// marker in its title or short introduction; paid products that merely come
// with a bonus (【特典付き】) are not bonuses.
func PurchaseBonusHintFor(product Product) (PurchaseBonusHint, bool) {
	free := product.IsPermanentlyFree()
	if free == nil || !*free {
		return PurchaseBonusHint{}, false
	}
	code := strings.ToUpper(strings.TrimSpace(firstNonEmpty(product.WorkNo, product.ProductID)))
	makerID := strings.ToUpper(strings.TrimSpace(product.MakerID))
	if code == "" || !makerIDPattern.MatchString(makerID) {
		return PurchaseBonusHint{}, false
	}
	marked := false
	parentName := ""
	for _, text := range []string{product.WorkName, product.ProductName, product.IntroShort} {
		isBonus, name := purchaseBonusMarker(text)
		if !isBonus {
			continue
		}
		marked = true
		if parentName == "" {
			parentName = name
		}
	}
	if !marked {
		return PurchaseBonusHint{}, false
	}
	return PurchaseBonusHint{
		Code:        code,
		MakerID:     makerID,
		TitleKana:   normalizeBonusText(product.WorkNameKana),
		ReleaseDate: releaseDay(product.RegistDate),
		ParentName:  parentName,
	}, true
}

// IsPurchaseBonusTitle reports whether a stored title carries a bonus marker.
// Callers combine it with the stored free flag to exclude bonus candidates.
func IsPurchaseBonusTitle(title string) bool {
	isBonus, _ := purchaseBonusMarker(title)
	return isBonus
}

// PurchaseBonusCandidateFromProduct reads the fields used for scoring.
func PurchaseBonusCandidateFromProduct(product Product) PurchaseBonusCandidate {
	free := product.IsPermanentlyFree()
	return PurchaseBonusCandidate{
		Code:        strings.ToUpper(strings.TrimSpace(firstNonEmpty(product.WorkNo, product.ProductID))),
		MakerID:     strings.ToUpper(strings.TrimSpace(product.MakerID)),
		Title:       firstNonEmpty(product.WorkName, product.ProductName),
		TitleKana:   product.WorkNameKana,
		ReleaseDate: product.RegistDate,
		Free:        free != nil && *free,
	}
}

// Match scores one candidate. Candidates from another maker, the bonus
// itself, and other bonuses never match.
func (hint PurchaseBonusHint) Match(candidate PurchaseBonusCandidate) PurchaseBonusMatch {
	code := strings.ToUpper(strings.TrimSpace(candidate.Code))
	if code == "" || code == hint.Code || !strings.EqualFold(strings.TrimSpace(candidate.MakerID), hint.MakerID) {
		return PurchaseBonusNoMatch
	}
	if candidate.Free && IsPurchaseBonusTitle(candidate.Title) {
		return PurchaseBonusNoMatch
	}
	if hint.TitleKana != "" && hint.TitleKana == normalizeBonusText(candidate.TitleKana) {
		return PurchaseBonusKanaMatch
	}
	if hint.ParentName != "" && hint.ReleaseDate != "" && hint.ReleaseDate == releaseDay(candidate.ReleaseDate) &&
		isSubsequence(hint.ParentName, normalizeBonusText(candidate.Title)) {
		return PurchaseBonusNameMatch
	}
	return PurchaseBonusNoMatch
}

// SelectPurchaseBonusParent returns the single candidate with the strongest
// evidence. Two distinct candidates sharing the strongest evidence are
// ambiguous and select nothing.
func (hint PurchaseBonusHint) SelectParent(candidates []PurchaseBonusCandidate) (string, PurchaseBonusMatch, bool) {
	best := PurchaseBonusNoMatch
	bestCodes := map[string]bool{}
	for _, candidate := range candidates {
		match := hint.Match(candidate)
		if match == PurchaseBonusNoMatch || match < best {
			continue
		}
		if match > best {
			best = match
			bestCodes = map[string]bool{}
		}
		bestCodes[strings.ToUpper(strings.TrimSpace(candidate.Code))] = true
	}
	if best == PurchaseBonusNoMatch {
		return "", PurchaseBonusNoMatch, false
	}
	if len(bestCodes) != 1 {
		return "", best, true
	}
	for code := range bestCodes {
		return code, best, false
	}
	return "", PurchaseBonusNoMatch, false
}

func purchaseBonusMarker(text string) (bool, string) {
	for _, match := range bonusBracketPattern.FindAllStringSubmatch(text, -1) {
		inner := match[1]
		if !isBonusMarkerText(inner) {
			continue
		}
		name := ""
		if quoted := bonusQuotedPattern.FindStringSubmatch(inner); quoted != nil {
			name = normalizeBonusText(quoted[1])
		}
		return true, name
	}
	return false, ""
}

func isBonusMarkerText(inner string) bool {
	if strings.Contains(inner, "特典") {
		// 【特典付き】 marks a paid product that includes a bonus.
		return !strings.Contains(inner, "付")
	}
	return englishBonusPattern.MatchString(inner)
}

// normalizeBonusText folds width and case and keeps only letters and digits,
// so punctuation, spaces, and decoration do not affect comparison.
func normalizeBonusText(value string) string {
	value = strings.ToLower(norm.NFKC.String(value))
	var builder strings.Builder
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func releaseDay(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < len("2006-01-02") {
		return ""
	}
	return value[:len("2006-01-02")]
}

// isSubsequence reports whether needle's runes appear in haystack in order.
// Bonus markers often abbreviate the parent title (Example Work for
// Example Wonderful Work…), so a contiguous match is too strict.
func isSubsequence(needle string, haystack string) bool {
	needleRunes := []rune(needle)
	if len(needleRunes) < 3 {
		return false
	}
	index := 0
	for _, r := range haystack {
		if r == needleRunes[index] {
			index++
			if index == len(needleRunes) {
				return true
			}
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
