package httpapi

import (
	"context"
	"strings"
	"time"
)

const (
	defaultCatalogFreshnessDays = 30
	minimumCatalogFreshnessDays = 1
	maximumCatalogFreshnessDays = 365

	catalogSyncNever         = "never"
	catalogSyncAttention     = "attention"
	catalogSyncSynced        = "synced"
	catalogSyncNotApplicable = "not_applicable"
)

// catalogFreshnessDays keeps the former circle-only value working after the
// setting became a shared creator-catalog freshness window.
func (s *Server) catalogFreshnessDays(ctx context.Context) int {
	days := s.settingIntContext(ctx, "catalog_freshness_days", -1)
	if days == -1 {
		days = s.settingIntContext(ctx, "circle_auto_refresh_days", defaultCatalogFreshnessDays)
	}
	if days < minimumCatalogFreshnessDays || days > maximumCatalogFreshnessDays {
		return defaultCatalogFreshnessDays
	}
	return days
}

func catalogFreshnessState(lastSuccessAt string, lastAttemptAt string, freshnessDays int, now time.Time) (string, string) {
	lastSuccessAt = strings.TrimSpace(lastSuccessAt)
	if lastSuccessAt == "" {
		if strings.TrimSpace(lastAttemptAt) != "" {
			return catalogSyncAttention, "no_successful_pull"
		}
		return catalogSyncNever, "never"
	}
	lastSuccess, err := parseSQLiteTime(lastSuccessAt)
	if err != nil {
		return catalogSyncAttention, "invalid_timestamp"
	}
	if !now.Before(lastSuccess.Add(time.Duration(freshnessDays) * 24 * time.Hour)) {
		return catalogSyncAttention, "stale"
	}
	return catalogSyncSynced, ""
}
