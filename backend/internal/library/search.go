package library

import (
	"regexp"
	"strconv"
	"strings"
)

type SearchClause struct {
	Kind  string
	Value string
}

var wrappedSearchPattern = regexp.MustCompile(`(?i)\$(-?mytag|-?tagw?|-?circle|-?va|duration|-duration|rate|sell|age|lang):([^$]+)\$`)
var splitSearchPattern = regexp.MustCompile(`(\S+):"([^"]+)"|(\S+):'([^']+)'|"([^"]+)"|'([^']+)'|(\S+)`)
var workCodePattern = regexp.MustCompile(`(?i)^(RJ|BJ|VJ|CC)[0-9]{4,8}$`)
var numericSearchPattern = regexp.MustCompile(`[^0-9.]`)

func ParseSearchClauses(query string) []SearchClause {
	clauses := []SearchClause{}
	rest := strings.TrimSpace(query)
	rest = wrappedSearchPattern.ReplaceAllStringFunc(rest, func(match string) string {
		parts := wrappedSearchPattern.FindStringSubmatch(match)
		if len(parts) == 3 {
			if clause, ok := searchClauseFromKey(parts[1], parts[2]); ok {
				clauses = append(clauses, clause)
			}
		}
		return " "
	})
	parts := splitSearchParts(rest)
	for index := 0; index < len(parts); index++ {
		part := strings.TrimSpace(parts[index])
		if part == "" {
			continue
		}
		if key, ok := strings.CutSuffix(part, ":"); ok && index+1 < len(parts) {
			if clause, matched := searchClauseFromKey(key, parts[index+1]); matched {
				clauses = append(clauses, clause)
				index++
				continue
			}
		}
		if key, value, ok := strings.Cut(part, ":"); ok {
			if clause, matched := searchClauseFromKey(key, value); matched {
				clauses = append(clauses, clause)
				continue
			}
		}
		kind := "text"
		if workCodePattern.MatchString(part) {
			kind = "code"
		}
		clauses = append(clauses, SearchClause{Kind: kind, Value: part})
	}
	return clauses
}

func NumericClauseValue(value string) float64 {
	cleaned := numericSearchPattern.ReplaceAllString(value, "")
	parsed, err := strconv.ParseFloat(cleaned, 64)
	if err != nil {
		return 0
	}
	return parsed
}

func splitSearchParts(value string) []string {
	parts := []string{}
	for _, match := range splitSearchPattern.FindAllStringSubmatch(value, -1) {
		switch {
		case match[1] != "":
			parts = append(parts, match[1]+":"+match[2])
		case match[3] != "":
			parts = append(parts, match[3]+":"+match[4])
		case match[5] != "":
			parts = append(parts, match[5])
		case match[6] != "":
			parts = append(parts, match[6])
		case match[7] != "":
			parts = append(parts, match[7])
		}
	}
	return parts
}

func searchClauseFromKey(key string, value string) (SearchClause, bool) {
	key = strings.ToLower(strings.TrimSpace(key))
	value = strings.TrimSpace(value)
	if value == "" {
		return SearchClause{}, false
	}
	switch key {
	case "circle":
		return SearchClause{Kind: "circle", Value: value}, true
	case "va", "voice", "creator":
		return SearchClause{Kind: "voice_actor", Value: value}, true
	case "tag", "tagw":
		return SearchClause{Kind: "tag", Value: value}, true
	case "-tag", "-tagw":
		return SearchClause{Kind: "exclude_tag", Value: value}, true
	case "mytag":
		return SearchClause{Kind: "user_tag", Value: value}, true
	case "-mytag":
		return SearchClause{Kind: "exclude_user_tag", Value: value}, true
	case "rate", "rating":
		return SearchClause{Kind: "rating_min", Value: value}, true
	case "sell", "sales":
		return SearchClause{Kind: "sales_min", Value: value}, true
	case "duration":
		return SearchClause{Kind: "duration_min", Value: value}, true
	case "-duration":
		return SearchClause{Kind: "duration_max", Value: value}, true
	case "age":
		return SearchClause{Kind: "age", Value: value}, true
	case "lang", "language":
		return SearchClause{Kind: "language", Value: value}, true
	default:
		return SearchClause{}, false
	}
}
