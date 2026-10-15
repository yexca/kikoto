package contentpolicy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"github.com/yexca/kikoto/backend/internal/agerating"
	"golang.org/x/text/unicode/norm"
)

type KeywordRule struct {
	ID     string   `json:"id"`
	Term   string   `json:"term"`
	Fields []string `json:"fields"`
	Action string   `json:"action"`
}
type TagRule struct {
	TagID  int64  `json:"tagId"`
	Action string `json:"action"`
}
type Policy struct {
	Revision          int64         `json:"revision"`
	AlwaysScanAllAges bool          `json:"alwaysScanAllAges"`
	RemoteLyrics      bool          `json:"remoteLyrics"`
	TagIDs            []int64       `json:"tagIds,omitempty"` // Legacy sensitive tags, normalized into TagRules.
	TagRules          []TagRule     `json:"tagRules"`
	Keywords          []KeywordRule `json:"keywords"`
}
type Match struct {
	Kind   string `json:"kind"`
	Rule   string `json:"rule"`
	Field  string `json:"field"`
	Action string `json:"action"`
}
type Assessment struct {
	Class   string  `json:"class"`
	Reason  string  `json:"reason"`
	Matches []Match `json:"matches"`
}

func DefaultPolicy() Policy { return Policy{TagRules: []TagRule{}, Keywords: []KeywordRule{}} }
func NormalizeText(value string) string {
	value = norm.NFKC.String(strings.ToLower(strings.TrimSpace(value)))
	return strings.Join(strings.Fields(value), " ")
}

// Validate rejects the whole configuration rather than silently dropping rules.
// Legacy rules receive a deterministic identity based on their complete scope.
func (p Policy) Validate() (Policy, error) {
	if len(p.TagIDs)+len(p.TagRules) > 512 || len(p.Keywords) > 512 {
		return p, fmt.Errorf("at most 512 tags and 512 keyword rules are allowed")
	}
	result := DefaultPolicy()
	result.Revision = p.Revision
	result.AlwaysScanAllAges, result.RemoteLyrics = p.AlwaysScanAllAges, p.RemoteLyrics
	seenTags := map[int64]string{}
	rules := append([]TagRule{}, p.TagRules...)
	for _, id := range p.TagIDs {
		rules = append(rules, TagRule{TagID: id, Action: "sensitive"})
	}
	for _, rule := range rules {
		if rule.TagID <= 0 || !validAction(rule.Action) {
			return p, fmt.Errorf("tag rules require positive tag IDs and a sensitive, restricted or blocked action")
		}
		if action, exists := seenTags[rule.TagID]; exists {
			if action != rule.Action {
				return p, fmt.Errorf("a tag cannot have conflicting actions")
			}
			continue
		}
		result.TagRules = append(result.TagRules, rule)
		seenTags[rule.TagID] = rule.Action
	}
	seenIDs := map[string]bool{}
	for i, rule := range p.Keywords {
		rule.Term = NormalizeText(rule.Term)
		if rule.Term == "" || len(rule.Term) > 256 || strings.ContainsFunc(rule.Term, unicode.IsControl) {
			return p, fmt.Errorf("rule %d: enter a keyword of 1–256 bytes without control characters", i+1)
		}
		if !validAction(rule.Action) {
			return p, fmt.Errorf("rule %d: choose sensitive, restricted or blocked", i+1)
		}
		if len(rule.Fields) == 0 || len(rule.Fields) > 5 {
			return p, fmt.Errorf("rule %d: choose one or more text fields", i+1)
		}
		seen := map[string]bool{}
		fields := []string{}
		for _, field := range rule.Fields {
			if field != "title" && field != "description" && field != "tags" && field != "lyrics" && field != "all" {
				return p, fmt.Errorf("rule %d: unknown text field %q", i+1, field)
			}
			if !seen[field] {
				fields = append(fields, field)
				seen[field] = true
			}
		}
		rule.Fields = fields
		if rule.ID == "" {
			data, _ := json.Marshal(rule)
			h := sha256.Sum256(data)
			rule.ID = "rule-" + hex.EncodeToString(h[:16]) + "-" + strconv.Itoa(i)
		}
		if len(rule.ID) > 80 || strings.ContainsFunc(rule.ID, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '-' && r != '_' }) || seenIDs[rule.ID] {
			return p, fmt.Errorf("rule %d: rule identity is invalid or duplicated", i+1)
		}
		seenIDs[rule.ID] = true
		result.Keywords = append(result.Keywords, rule)
	}
	return result, nil
}
func (p Policy) Normalized() Policy {
	result, err := p.Validate()
	if err != nil {
		return p
	}
	return result
}
func (p Policy) Assess(age string, fields map[string]string, tagIDs []int64) Assessment {
	p, err := p.Validate()
	if err != nil {
		return Assessment{Class: "unknown", Reason: "content policy is invalid", Matches: []Match{}}
	}
	known := len(agerating.Aliases(age)) > 0
	general := known && agerating.Matches(age, "general")
	result := Assessment{Class: "safe", Reason: "no configured rule matched", Matches: []Match{}}
	if !known {
		result.Class, result.Reason = "unknown", "age rating is missing or unknown"
	} else if !general {
		result.Class, result.Reason = "sensitive", "restricted age rating"
	}
	for _, id := range tagIDs {
		for _, configured := range p.TagRules {
			if id == configured.TagID {
				result.Matches = append(result.Matches, Match{Kind: "tag", Rule: "tag:" + strconv.FormatInt(id, 10), Field: "tags", Action: configured.Action})
			}
		}
	}
	normalizedFields := map[string]string{}
	for field, value := range fields {
		normalizedFields[field] = NormalizeText(value)
	}
	for _, rule := range p.Keywords {
		// Restricted and blocking rules apply to every rating. The all-ages
		// shortcut only skips additional sensitive keyword checks.
		if general && !p.AlwaysScanAllAges && rule.Action == "sensitive" {
			continue
		}
		for _, field := range []string{"title", "description", "tags", "lyrics"} {
			if ruleApplies(rule.Fields, field) && strings.Contains(normalizedFields[field], rule.Term) {
				result.Matches = append(result.Matches, Match{Kind: "keyword", Rule: rule.ID, Field: field, Action: rule.Action})
			}
		}
	}
	for _, match := range result.Matches {
		if match.Action == "blocked" {
			result.Class, result.Reason = "blocked", "a configured blocking rule matched"
			return result
		}
	}
	if known {
		for _, match := range result.Matches {
			if match.Action == "restricted" {
				result.Class, result.Reason = "restricted", "a configured high-sensitivity rule matched"
				return result
			}
		}
		if len(result.Matches) > 0 {
			result.Class, result.Reason = "sensitive", "a configured sensitive rule matched"
		}
	}
	return result
}
func ruleApplies(fields []string, field string) bool {
	for _, value := range fields {
		if value == "all" || value == field {
			return true
		}
	}
	return false
}

// NormalizeMaxClass preserves the receive scope of settings with no explicit
// maximum. A legacy sensitive opt-in applies only to a private service.
func NormalizeMaxClass(maximum, boundary string, allowSensitive bool) (string, error) {
	if maximum == "" {
		if boundary == "private" && allowSensitive {
			return "sensitive", nil
		}
		return "safe", nil
	}
	if maximum != "safe" && maximum != "sensitive" && maximum != "restricted" {
		return "", fmt.Errorf("choose a safe, sensitive or restricted content maximum")
	}
	return maximum, nil
}

// Allows is shared by ASR and LLM send boundaries. Unknown, blocked and invalid
// classes or maxima always fail closed, including an otherwise safe input.
func Allows(class, maximum string) bool {
	ranks := map[string]int{"safe": 1, "sensitive": 2, "restricted": 3}
	content, validContent := ranks[class]
	limit, validLimit := ranks[maximum]
	return validContent && validLimit && content <= limit
}

func validAction(action string) bool {
	return action == "sensitive" || action == "restricted" || action == "blocked"
}
