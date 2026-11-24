// Package filesource reads stored file sources: a file_source row, its
// file_source_endpoint, and the JSON settings they hold. Every reader decodes
// and normalizes a record here, so all of them see the same values. A stored
// setting that cannot be decoded is reported on the record rather than
// replaced with defaults the administrator never chose.
package filesource

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

const (
	// TypeKikoeruCompatible is a remote source with a Kikoeru-compatible API.
	TypeKikoeruCompatible = "kikoeru_compatible"
	// TypeKikoeruCompatible178 is a retained remote type that existing sources
	// keep but new configuration cannot select.
	TypeKikoeruCompatible178 = "kikoeru_compatible_number178"
	// TypeLocalFolder is the local library, managed by the local scan settings.
	TypeLocalFolder = "local_folder"

	// CapabilityMetadata is the capability a remote source declares when it
	// can describe works, not only serve their files.
	CapabilityMetadata = "metadata"
	// DefaultRequestLanguage is the request language of a remote source that
	// stores none.
	DefaultRequestLanguage = "ja-JP"
)

// ErrUnreadableSettings marks a record whose stored JSON settings cannot be
// decoded.
var ErrUnreadableSettings = errors.New("stored file source settings cannot be decoded")

// IsRemoteType reports whether a source type has a remote API.
func IsRemoteType(sourceType string) bool {
	return sourceType == TypeKikoeruCompatible || sourceType == TypeKikoeruCompatible178
}

// Config is the stored file_source.config_json.
type Config struct {
	SaveRootTemplate string `json:"saveRootTemplate,omitempty"`
	ScanDepth        *int   `json:"scanDepth,omitempty"`
	RequestLanguage  string `json:"requestLanguage,omitempty"`
	// Capabilities declares what a remote source offers beyond its files. A
	// nil list keeps the source type's default; an empty list declares none.
	Capabilities *[]string `json:"capabilities,omitempty"`
}

// Endpoint is the stored file_source_endpoint. AllowedHostPatterns is the
// decoded allowed_host_patterns_json and is never nil.
type Endpoint struct {
	BaseURL               string   `json:"baseUrl"`
	APIURL                string   `json:"apiUrl"`
	FallbackURL           string   `json:"fallbackUrl"`
	WorkURLTemplate       string   `json:"workUrlTemplate"`
	RestrictOutboundHosts bool     `json:"restrictOutboundHosts"`
	AllowedHostPatterns   []string `json:"allowedHostPatterns"`
}

// Record is one stored file source as written. A source without an endpoint
// row has empty endpoint fields and the health status "unknown".
type Record struct {
	ID            int64
	Code          string
	DisplayName   string
	SourceType    string
	Priority      int
	Enabled       bool
	Config        Config
	Endpoint      Endpoint
	HealthStatus  string
	LastCheckedAt *string
	// SettingsErr wraps ErrUnreadableSettings when config_json or
	// allowed_host_patterns_json cannot be decoded. Config and Endpoint then
	// hold only what did decode, normalized, and ForUse refuses the record.
	SettingsErr error
}

// ForUse returns the record as a client uses it: an empty API URL falls back
// to the public-site URL. It refuses a record whose stored settings cannot be
// decoded with that record's SettingsErr.
func (r Record) ForUse() (Record, error) {
	if r.SettingsErr != nil {
		return Record{}, r.SettingsErr
	}
	if strings.TrimSpace(r.Endpoint.APIURL) == "" {
		r.Endpoint.APIURL = r.Endpoint.BaseURL
	}
	return r, nil
}

// Scope selects which sources List reads.
type Scope int

const (
	// AllSources reads every file source, the local library included.
	AllSources Scope = iota
	// RemoteSources reads only sources of a remote type.
	RemoteSources
)

// Querier is satisfied by *sql.DB, *sql.Tx, *sql.Conn, and *sqlutil.DB.
type Querier interface {
	sqlutil.RowQuerier
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

const selectRecord = `
	SELECT source.id, source.code, source.display_name, source.source_type, source.priority,
		source.enabled, source.config_json,
		COALESCE(endpoint.base_url, ''), COALESCE(endpoint.api_url, ''), COALESCE(endpoint.fallback_url, ''),
		COALESCE(endpoint.work_url_template, ''), COALESCE(endpoint.restrict_outbound_hosts, 0),
		COALESCE(endpoint.allowed_host_patterns_json, '[]'),
		COALESCE(endpoint.health_status, 'unknown'), endpoint.last_checked_at
	FROM file_source AS source
	LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id`

// Get reads one source. It returns sql.ErrNoRows when no source has the id.
func Get(ctx context.Context, q Querier, id int64) (Record, error) {
	return scan(q.QueryRowContext(ctx, selectRecord+`
	WHERE source.id = ?`, id))
}

// List reads the sources in scope by priority, then id.
func List(ctx context.Context, q Querier, scope Scope) ([]Record, error) {
	query := selectRecord
	args := []any{}
	if scope == RemoteSources {
		query += `
	WHERE source.source_type IN (?, ?)`
		args = append(args, TypeKikoeruCompatible, TypeKikoeruCompatible178)
	}
	rows, err := q.QueryContext(ctx, query+`
	ORDER BY source.priority ASC, source.id ASC`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	records := []Record{}
	for rows.Next() {
		record, err := scan(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

type scanner interface {
	Scan(dest ...any) error
}

func scan(row scanner) (Record, error) {
	var record Record
	var configJSON, allowedHostPatternsJSON string
	var lastCheckedAt sql.NullString
	if err := row.Scan(
		&record.ID,
		&record.Code,
		&record.DisplayName,
		&record.SourceType,
		&record.Priority,
		&record.Enabled,
		&configJSON,
		&record.Endpoint.BaseURL,
		&record.Endpoint.APIURL,
		&record.Endpoint.FallbackURL,
		&record.Endpoint.WorkURLTemplate,
		&record.Endpoint.RestrictOutboundHosts,
		&allowedHostPatternsJSON,
		&record.HealthStatus,
		&lastCheckedAt,
	); err != nil {
		return Record{}, err
	}
	record.LastCheckedAt = sqlutil.String(lastCheckedAt)
	var problems []error
	if err := decodeStored(configJSON, &record.Config); err != nil {
		problems = append(problems, fmt.Errorf("config_json: %w", err))
	}
	NormalizeConfig(&record.Config, record.SourceType)
	if err := decodeStored(allowedHostPatternsJSON, &record.Endpoint.AllowedHostPatterns); err != nil {
		problems = append(problems, fmt.Errorf("allowed_host_patterns_json: %w", err))
	}
	if record.Endpoint.AllowedHostPatterns == nil {
		record.Endpoint.AllowedHostPatterns = []string{}
	}
	if len(problems) > 0 {
		record.SettingsErr = fmt.Errorf("file source %d: %w: %w", record.ID, ErrUnreadableSettings, errors.Join(problems...))
	}
	return record, nil
}

// decodeStored decodes one stored JSON setting. An empty value is the
// setting's default; anything else must decode.
func decodeStored(raw string, target any) error {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	return json.Unmarshal([]byte(raw), target)
}

// NormalizeConfig applies the stored-config rules for a source type: only a
// remote source declares capabilities, and only the metadata capability; a
// remote source always has a request language.
func NormalizeConfig(config *Config, sourceType string) {
	if !IsRemoteType(sourceType) {
		config.Capabilities = nil
		return
	}
	if config.Capabilities != nil {
		capabilities := []string{}
		for _, capability := range *config.Capabilities {
			if capability == CapabilityMetadata && len(capabilities) == 0 {
				capabilities = append(capabilities, capability)
			}
		}
		config.Capabilities = &capabilities
	}
	raw := strings.TrimSpace(config.RequestLanguage)
	if raw == "" {
		config.RequestLanguage = DefaultRequestLanguage
		return
	}
	config.RequestLanguage = NormalizeRequestLanguage(raw)
}

var requestLanguagePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})*$`)

// NormalizeRequestLanguage canonicalizes a BCP-47-like tag: a lowercase
// language, title-case script, uppercase region, and lowercase variants. An
// empty value is DefaultRequestLanguage; a value that is not a tag is "".
func NormalizeRequestLanguage(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "_", "-"))
	if value == "" {
		return DefaultRequestLanguage
	}
	if !requestLanguagePattern.MatchString(value) {
		return ""
	}
	parts := strings.Split(value, "-")
	parts[0] = strings.ToLower(parts[0])
	for index := 1; index < len(parts); index++ {
		if len(parts[index]) == 4 {
			parts[index] = strings.ToUpper(parts[index][:1]) + strings.ToLower(parts[index][1:])
		} else if len(parts[index]) == 2 || len(parts[index]) == 3 {
			parts[index] = strings.ToUpper(parts[index])
		} else {
			parts[index] = strings.ToLower(parts[index])
		}
	}
	return strings.Join(parts, "-")
}
