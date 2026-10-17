package dlsite

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

type Product struct {
	WorkNo            string            `json:"workno"`
	ProductID         string            `json:"product_id"`
	SiteID            string            `json:"site_id"`
	SiteIDTouch       string            `json:"site_id_touch"`
	MakerID           string            `json:"maker_id"`
	MakerName         string            `json:"maker_name"`
	ProductName       string            `json:"product_name"`
	WorkName          string            `json:"work_name"`
	WorkNameKana      string            `json:"work_name_kana"`
	Intro             string            `json:"intro"`
	IntroShort        string            `json:"intro_s"`
	RegistDate        string            `json:"regist_date"`
	AgeCategoryString string            `json:"age_category_string"`
	WorkType          string            `json:"work_type"`
	WorkTypeString    string            `json:"work_type_string"`
	ImageMain         Image             `json:"image_main"`
	ImageThumb        Image             `json:"image_thum"`
	ImageThumbMini    Image             `json:"image_thum_mini"`
	Genres            []Genre           `json:"genres"`
	Creators          Creators          `json:"creaters"`
	TranslationInfo   TranslationInfo   `json:"translation_info"`
	LanguageEditions  []LanguageEdition `json:"language_editions"`
	Raw               json.RawMessage   `json:"-"`
	ProductRaw        json.RawMessage   `json:"-"`
	DynamicRaw        json.RawMessage   `json:"-"`
	RateAverage2DP    *float64          `json:"rate_average_2dp"`
	SalesCount        *int64            `json:"dl_count"`
	RegularPrice      *int64            `json:"official_price"`
	CurrentPrice      *int64            `json:"price"`
	DiscountRate      *int64            `json:"discount_rate"`
	IsDiscount        *bool             `json:"is_discount"`
	IsSale            *bool             `json:"is_sale"`
	IsFree            *bool             `json:"is_free"`
	Language          string            `json:"-"`
	// RequestLocale records the locale sent to DLsite. It is deliberately
	// separate from the edition language, which is provider metadata.
	RequestLocale string `json:"-"`
	// MetadataSourceCode is set when Kikoto stores this product's metadata on
	// another work through a user-declared metadata link.
	MetadataSourceCode string `json:"-"`
	// PurchaseBonusParentCode is set when Kikoto filled this purchase bonus's
	// empty fields from its parent product; PurchaseBonusInherited names the
	// filled groups.
	PurchaseBonusParentCode string   `json:"-"`
	PurchaseBonusInherited  []string `json:"-"`
}

func (product Product) IsPermanentlyFree() *bool {
	if product.RegularPrice == nil || product.CurrentPrice == nil {
		return nil
	}
	permanentlyFree := *product.RegularPrice == 0 && *product.CurrentPrice == 0
	if product.DiscountRate != nil && *product.DiscountRate > 0 {
		permanentlyFree = false
	}
	if product.IsDiscount != nil && *product.IsDiscount {
		permanentlyFree = false
	}
	return &permanentlyFree
}

type TranslationInfo struct {
	OriginalWorkNo            string              `json:"original_workno"`
	ParentWorkNo              string              `json:"parent_workno"`
	Lang                      string              `json:"lang"`
	StatusForTranslatorByLang TranslationStatuses `json:"translation_status_for_translator"`
}

type TranslationStatus struct {
	AppliedCount int  `json:"applied_count"`
	OnSaleCount  *int `json:"on_sale_count"`
}

type TranslationStatuses map[string]TranslationStatus

func (statuses *TranslationStatuses) UnmarshalJSON(data []byte) error {
	trimmed := strings.TrimSpace(string(data))
	if trimmed == "" || trimmed == "null" {
		*statuses = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "{") {
		var parsed map[string]TranslationStatus
		if err := json.Unmarshal(data, &parsed); err != nil {
			return err
		}
		*statuses = parsed
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var parsed []json.RawMessage
		if err := json.Unmarshal(data, &parsed); err != nil {
			return err
		}
		if len(parsed) == 0 {
			*statuses = TranslationStatuses{}
			return nil
		}
		return fmt.Errorf("translation status must be an object or empty array")
	}
	return fmt.Errorf("translation status must be an object, empty array, or null")
}

type LanguageEdition struct {
	WorkNo       string `json:"workno"`
	EditionID    int64  `json:"edition_id"`
	EditionType  string `json:"edition_type"`
	DisplayOrder int    `json:"display_order"`
	Label        string `json:"label"`
	Lang         string `json:"lang"`
}

// LanguageEditionList accepts both the normal array returned by DLsite and
// the numeric-keyed object used when the provider serializes a sparse array.
// The object keys are ordering hints; display_order remains the provider's
// relationship order and is handled separately by metadata sync.
type LanguageEditionList []LanguageEdition

// UnmarshalJSON keeps Product's public slice type compatible while decoding
// the two shapes accepted by LanguageEditionList.
func (product *Product) UnmarshalJSON(data []byte) error {
	type productAlias Product
	decoded := struct {
		LanguageEditions json.RawMessage `json:"language_editions"`
		*productAlias
	}{productAlias: (*productAlias)(product)}
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	if decoded.LanguageEditions != nil {
		var editions LanguageEditionList
		if err := json.Unmarshal(decoded.LanguageEditions, &editions); err != nil {
			return err
		}
		product.LanguageEditions = []LanguageEdition(editions)
	}
	return nil
}

func (editions *LanguageEditionList) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*editions = nil
		return nil
	}
	if len(data) == 0 {
		return fmt.Errorf("language_editions is empty JSON")
	}
	switch data[0] {
	case '[':
		var decoded []LanguageEdition
		if err := json.Unmarshal(data, &decoded); err != nil {
			return fmt.Errorf("decode language_editions array: %w", err)
		}
		*editions = LanguageEditionList(decoded)
		return nil
	case '{':
		var values map[string]json.RawMessage
		if err := json.Unmarshal(data, &values); err != nil {
			return fmt.Errorf("decode language_editions object: %w", err)
		}
		indexed := make([]indexedLanguageEdition, 0, len(values))
		for key, raw := range values {
			index, err := parseLanguageEditionIndex(key)
			if err != nil {
				return err
			}
			var edition LanguageEdition
			if err := json.Unmarshal(raw, &edition); err != nil {
				return fmt.Errorf("decode language_editions object value: %w", err)
			}
			indexed = append(indexed, indexedLanguageEdition{index: index, key: key, edition: edition})
		}
		sort.Slice(indexed, func(left, right int) bool {
			if indexed[left].index != indexed[right].index {
				return indexed[left].index < indexed[right].index
			}
			return indexed[left].key < indexed[right].key
		})
		decoded := make(LanguageEditionList, len(indexed))
		for index, value := range indexed {
			decoded[index] = value.edition
		}
		*editions = decoded
		return nil
	default:
		return fmt.Errorf("language_editions must be an array, numeric-keyed object, or null")
	}
}

type indexedLanguageEdition struct {
	index   uint64
	key     string
	edition LanguageEdition
}

func parseLanguageEditionIndex(key string) (uint64, error) {
	if key == "" || strings.IndexFunc(key, func(value rune) bool { return value < '0' || value > '9' }) >= 0 {
		return 0, fmt.Errorf("language_editions object contains a non-numeric key")
	}
	index, err := strconv.ParseUint(key, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("language_editions object contains an invalid numeric key")
	}
	return index, nil
}

// LanguageTokens returns the provider's language values as individual tokens.
// A few DLsite responses incorrectly join all family languages in one field.
func (edition LanguageEdition) LanguageTokens() []string {
	parts := strings.Split(edition.Lang, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		if part = strings.TrimSpace(part); part != "" {
			result = append(result, part)
		}
	}
	return result
}

const OriginMetadataLanguage = "origin"

var SupportedMetadataLanguages = []string{"ja-jp", "en-us", "zh-cn", "zh-tw", "ko-kr"}

// NormalizeMetadataLanguage converts the locale and DLsite edition spellings
// used by the provider into the stable tokens exposed by the settings API.
// Unknown provider languages are intentionally returned as an empty token so
// callers can retain the raw value without making it configurable.
func NormalizeMetadataLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "_", "-"))) {
	case OriginMetadataLanguage:
		return OriginMetadataLanguage
	case "ja", "jp", "ja-jp", "jpn", "japanese", "日本語":
		return "ja-jp"
	case "en", "en-us", "eng", "english":
		return "en-us"
	case "zh", "zh-cn", "cn", "chi-hans", "chi-simp", "chi-hans-cn", "simplified chinese", "简体中文":
		return "zh-cn"
	case "zh-tw", "tw", "chi-hant", "chi-trad", "chi-hant-tw", "traditional chinese", "繁體中文", "繁体中文":
		return "zh-tw"
	case "ko", "ko-kr", "kor", "korean", "한국어":
		return "ko-kr"
	default:
		return ""
	}
}

// EditionMetadataLanguage returns a supported settings token for a provider
// edition language. Unknown values remain unknown to the priority matcher.
func EditionMetadataLanguage(value string) string {
	return NormalizeMetadataLanguage(value)
}

// LocaleForMetadataLanguage returns the locale that most reliably yields
// metadata for the corresponding DLsite edition.
func LocaleForMetadataLanguage(value string) string {
	switch NormalizeMetadataLanguage(value) {
	case "ja-jp":
		return "ja-jp"
	case "en-us":
		return "en-us"
	case "zh-cn":
		return "zh-cn"
	case "zh-tw":
		return "zh-tw"
	case "ko-kr":
		return "ko-kr"
	default:
		return ""
	}
}

// NormalizeMetadataPriority removes unsupported values and keeps origin as the
// final, non-removable fallback. Supported languages are opt-in; a new
// installation therefore displays the canonical edition until an
// administrator adds localized preferences.
func NormalizeMetadataPriority(values []string) []string {
	result := make([]string, 0, len(SupportedMetadataLanguages)+1)
	seen := map[string]bool{}
	for _, value := range values {
		language := NormalizeMetadataLanguage(value)
		if language == "" || language == OriginMetadataLanguage || seen[language] {
			continue
		}
		seen[language] = true
		result = append(result, language)
	}
	result = append(result, OriginMetadataLanguage)
	return result
}

type Image struct {
	URL         string `json:"url"`
	ResizeURL   string `json:"resize_url"`
	RelativeURL string `json:"relative_url"`
}

// Genre is one DLsite genre tag. ID is stable across request locales, Name is
// localized for the request locale, and NameBase is the Japanese name.
type Genre struct {
	ID       GenreID `json:"id"`
	Name     string  `json:"name"`
	NameBase string  `json:"name_base"`
}

// GenreID is a positive DLsite genre id, or zero when the provider omits it or
// sends a value that is not a positive integer. An unexpected id must not fail
// decoding of the whole product.
type GenreID int64

func (id *GenreID) UnmarshalJSON(data []byte) error {
	*id = 0
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return nil
	}
	var parsed int64
	switch typed := value.(type) {
	case float64:
		if typed != float64(int64(typed)) {
			return nil
		}
		parsed = int64(typed)
	case string:
		number, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
		if err != nil {
			return nil
		}
		parsed = number
	}
	if parsed > 0 {
		*id = GenreID(parsed)
	}
	return nil
}

type Creator struct {
	Name           string `json:"name"`
	Classification string `json:"classification"`
}

type Creators map[string][]Creator

func (c *Creators) UnmarshalJSON(data []byte) error {
	var grouped map[string][]Creator
	if err := json.Unmarshal(data, &grouped); err == nil {
		*c = grouped
		return nil
	}
	var flat []Creator
	if err := json.Unmarshal(data, &flat); err != nil {
		return err
	}
	grouped = map[string][]Creator{}
	for _, creator := range flat {
		classification := strings.TrimSpace(creator.Classification)
		if classification == "" {
			classification = "unknown"
		}
		grouped[classification] = append(grouped[classification], creator)
	}
	*c = grouped
	return nil
}
