// Package remotemetadata applies metadata that configured remote file sources
// declare for a work. Remote sources never create work identities: they fill
// normalized fields of an existing work only while it has no DLsite metadata,
// in an order the administrator configures rather than in write order.
package remotemetadata

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// SettingKey stores the opt-in fallback switch and the ordered source ids.
const SettingKey = "remote_metadata_fallback"

// MaxSources bounds how many sources a fallback lookup may try for one work.
const MaxSources = 16

// CapabilityMetadata is the file_source config_json capability a source
// declares when it can describe works, not only serve their files.
const CapabilityMetadata = "metadata"

// ProviderCodePrefix derives a remote source's metadata provider identity from
// its stable source code, never from its configurable display name.
const ProviderCodePrefix = "kikoeru_source_"

// remoteSourceTypes are the file source types whose API can describe a work.
var remoteSourceTypes = map[string]bool{"kikoeru_compatible": true, "kikoeru_compatible_number178": true}

type Querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// Settings is the instance policy. The switch gates only the lookup after
// DLsite reports a work as not found and the folding of remote tags into
// shared tags; SourceIDs also orders every remote source's passive fills.
type Settings struct {
	Enabled   bool    `json:"enabled"`
	SourceIDs []int64 `json:"sourceIds"`
}

// LoadSettings reads the stored policy. A missing or malformed value is the
// default: disabled, with no selected sources.
func LoadSettings(ctx context.Context, q Querier) (Settings, error) {
	var raw string
	err := q.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", SettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Settings{SourceIDs: []int64{}}, nil
	}
	if err != nil {
		return Settings{}, err
	}
	var settings Settings
	if json.Unmarshal([]byte(raw), &settings) != nil {
		return Settings{SourceIDs: []int64{}}, nil
	}
	settings.SourceIDs = NormalizeSourceIDs(settings.SourceIDs)
	return settings, nil
}

// NormalizeSourceIDs keeps the first occurrence of each positive id, bounded.
func NormalizeSourceIDs(ids []int64) []int64 {
	result := []int64{}
	seen := map[int64]bool{}
	for _, id := range ids {
		if id <= 0 || seen[id] || len(result) >= MaxSources {
			continue
		}
		seen[id] = true
		result = append(result, id)
	}
	return result
}

// IsRemoteSourceType reports whether a file source type has a metadata API.
func IsRemoteSourceType(sourceType string) bool {
	return remoteSourceTypes[sourceType]
}

// SupportsMetadata reports a declared metadata capability. A remote source
// config written before capabilities existed declares the type's default; an
// explicit list, including an empty one, is authoritative.
func SupportsMetadata(sourceType, configJSON string) bool {
	if !IsRemoteSourceType(sourceType) {
		return false
	}
	var config struct {
		Capabilities *[]string `json:"capabilities"`
	}
	if strings.TrimSpace(configJSON) != "" && json.Unmarshal([]byte(configJSON), &config) != nil {
		return false
	}
	if config.Capabilities == nil {
		return true
	}
	for _, capability := range *config.Capabilities {
		if capability == CapabilityMetadata {
			return true
		}
	}
	return false
}

// ProviderCode returns the metadata provider code for a remote source code.
func ProviderCode(sourceCode string) string {
	return ProviderCodePrefix + sourceCode
}
