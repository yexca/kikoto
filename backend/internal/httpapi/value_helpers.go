package httpapi

import (
	"sort"
	"strings"
)

func sortedStringKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func nullableSeconds(value float64) any {
	if value <= 0 {
		return nil
	}
	return int64(value)
}

func normalizeDate(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if len(value) >= 10 {
		return value[:10]
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func cleanStringList(values []string, limit int) []string {
	cleaned := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if seen[key] {
			continue
		}
		seen[key] = true
		cleaned = append(cleaned, value)
		if len(cleaned) >= limit {
			break
		}
	}
	return cleaned
}

func nullableDuration(value *int64) any {
	if value == nil || *value <= 0 {
		return nil
	}
	return *value
}

func nullableBoolPointer(value *bool) any {
	if value == nil {
		return nil
	}
	return *value
}
