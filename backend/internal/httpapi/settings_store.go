package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

func (s *Server) settingStringContext(ctx context.Context, key string, fallback string) string {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value string
	if err := json.Unmarshal([]byte(raw), &value); err != nil || strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func upsertSetting(r *http.Request, tx *sql.Tx, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(r.Context(), `
		INSERT INTO app_setting (key, value_json)
		VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = CURRENT_TIMESTAMP
	`, key, string(encoded))
	return err
}

func (s *Server) settingInt(r *http.Request, key string, fallback int) int {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value int
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingIntContext(ctx context.Context, key string, fallback int) int {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value int
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingBool(r *http.Request, key string, fallback bool) bool {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value bool
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingFloat(r *http.Request, key string, fallback float64) float64 {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value float64
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingFloatContext(ctx context.Context, key string, fallback float64) float64 {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value float64
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingString(r *http.Request, key string, fallback string) string {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value string
	if err := json.Unmarshal([]byte(raw), &value); err != nil || strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func (s *Server) settingDirectoryRules(r *http.Request, key string, fallback []directoryRule) []directoryRule {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var rules []directoryRule
	if err := json.Unmarshal([]byte(raw), &rules); err != nil {
		return fallback
	}
	rules = normalizeDirectoryRoutingRules(rules)
	return rules
}

func (s *Server) settingBoolContext(ctx context.Context, key string, fallback bool) bool {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value bool
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}
