package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type remoteWorkTracksSnapshot struct {
	Source    remoteSourceForUse
	Work      kikoeru.Work
	Tracks    []kikoeru.Track
	ExpiresAt time.Time
}

type remoteWorkSnapshot struct {
	Source    remoteSourceForUse
	Work      kikoeru.Work
	ExpiresAt time.Time
}

type remoteSourceForUse struct {
	ID          int64
	Code        string
	DisplayName string
	SourceType  string
	Enabled     bool
	Config      fileSourceConfig
	Endpoint    fileSourceEndpoint
}

func (s *Server) loadRemoteSourceForUse(ctx context.Context, id int64) (remoteSourceForUse, error) {
	var source remoteSourceForUse
	var configJSON, allowedHostPatternsJSON string
	if err := s.db.QueryRowContext(ctx, `
		SELECT source.id, source.code, source.display_name, source.source_type, source.enabled, source.config_json,
			COALESCE(endpoint.api_url, ''), COALESCE(endpoint.base_url, ''), COALESCE(endpoint.fallback_url, ''),
			COALESCE(endpoint.work_url_template, ''), COALESCE(endpoint.restrict_outbound_hosts, 0),
			COALESCE(endpoint.allowed_host_patterns_json, '[]')
		FROM file_source AS source
		LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		WHERE source.id = ?
	`, id).Scan(
		&source.ID,
		&source.Code,
		&source.DisplayName,
		&source.SourceType,
		&source.Enabled,
		&configJSON,
		&source.Endpoint.APIURL,
		&source.Endpoint.BaseURL,
		&source.Endpoint.FallbackURL,
		&source.Endpoint.WorkURLTemplate,
		&source.Endpoint.RestrictOutboundHosts,
		&allowedHostPatternsJSON,
	); err != nil {
		return remoteSourceForUse{}, err
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		source.Endpoint.APIURL = source.Endpoint.BaseURL
	}
	if strings.TrimSpace(configJSON) != "" {
		_ = json.Unmarshal([]byte(configJSON), &source.Config)
	}
	normalizeFileSourceConfig(&source.Config, source.SourceType)
	_ = json.Unmarshal([]byte(allowedHostPatternsJSON), &source.Endpoint.AllowedHostPatterns)
	if source.Endpoint.AllowedHostPatterns == nil {
		source.Endpoint.AllowedHostPatterns = []string{}
	}
	return source, nil
}

func remoteWorkCodeFromPath(r *http.Request) string {
	return strings.TrimSpace(r.PathValue("code"))
}

func (s *Server) loadRemoteWorkTracks(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	source, remoteWork, err := s.loadRemoteWork(ctx, sourceID, code)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	tracks, err := s.loadRemoteTracks(ctx, source, remoteWork)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	return source, remoteWork, tracks, nil
}

func (s *Server) loadRemoteWork(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, error) {
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, kikoeru.Work{}, fmt.Errorf("source not found")
		}
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return remoteSourceForUse{}, kikoeru.Work{}, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := s.kikoeruClientForSource(source)
	remoteWork, _, err := s.resolveRemoteWorkForAccess(ctx, client, code)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		}
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	return source, remoteWork, nil
}

func (s *Server) loadRemoteTracks(ctx context.Context, source remoteSourceForUse, work kikoeru.Work) ([]kikoeru.Track, error) {
	tracks, _, err := s.kikoeruClientForSource(source).Tracks(ctx, work.ID)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		return nil, err
	}
	return tracks, nil
}

func (s *Server) loadRemoteWorkCached(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, error) {
	key := remoteWorkCacheKey(sourceID, code)
	now := time.Now()
	s.remoteWorkCacheMu.Lock()
	snapshot, found := s.remoteWorkCache[key]
	if found && now.Before(snapshot.ExpiresAt) {
		s.remoteWorkCacheMu.Unlock()
		return snapshot.Source, snapshot.Work, nil
	}
	if found {
		delete(s.remoteWorkCache, key)
	}
	if call := s.remoteWorkCacheCalls[key]; call != nil {
		s.remoteWorkCacheMu.Unlock()
		select {
		case <-ctx.Done():
			return remoteSourceForUse{}, kikoeru.Work{}, ctx.Err()
		case <-call.done:
			return call.source, call.work, call.err
		}
	}
	call := &remoteWorkCall{done: make(chan struct{})}
	s.remoteWorkCacheCalls[key] = call
	s.remoteWorkCacheMu.Unlock()

	source, work, err := s.loadRemoteWork(ctx, sourceID, code)
	call.source, call.work, call.err = source, work, err
	defer func() {
		s.remoteWorkCacheMu.Lock()
		delete(s.remoteWorkCacheCalls, key)
		close(call.done)
		s.remoteWorkCacheMu.Unlock()
	}()
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	s.remoteWorkCacheMu.Lock()
	pruneRemoteWorkSnapshots(s.remoteWorkCache, now)
	if len(s.remoteWorkCache) >= 64 {
		deleteOldestRemoteWorkSnapshot(s.remoteWorkCache)
	}
	s.remoteWorkCache[key] = remoteWorkSnapshot{Source: source, Work: work, ExpiresAt: now.Add(2 * time.Minute)}
	s.remoteWorkCacheMu.Unlock()
	return source, work, nil
}

func (s *Server) loadRemoteWorkTracksCached(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	source, work, err := s.loadRemoteWorkCached(ctx, sourceID, code)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	key := remoteWorkCacheKey(sourceID, code)
	now := time.Now()
	s.remoteWorkCacheMu.Lock()
	snapshot, found := s.remoteWorkTracksCache[key]
	if found && now.Before(snapshot.ExpiresAt) {
		s.remoteWorkCacheMu.Unlock()
		return snapshot.Source, snapshot.Work, snapshot.Tracks, nil
	}
	if found {
		delete(s.remoteWorkTracksCache, key)
	}
	if call := s.remoteWorkTracksCacheCalls[key]; call != nil {
		s.remoteWorkCacheMu.Unlock()
		select {
		case <-ctx.Done():
			return remoteSourceForUse{}, kikoeru.Work{}, nil, ctx.Err()
		case <-call.done:
			return call.source, call.work, call.tracks, call.err
		}
	}
	call := &remoteWorkTracksCall{done: make(chan struct{})}
	s.remoteWorkTracksCacheCalls[key] = call
	s.remoteWorkCacheMu.Unlock()

	tracks, err := s.loadRemoteTracks(ctx, source, work)
	call.source, call.work, call.tracks, call.err = source, work, tracks, err
	defer func() {
		s.remoteWorkCacheMu.Lock()
		delete(s.remoteWorkTracksCacheCalls, key)
		close(call.done)
		s.remoteWorkCacheMu.Unlock()
	}()
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	s.remoteWorkCacheMu.Lock()
	pruneRemoteWorkTracksSnapshots(s.remoteWorkTracksCache, now)
	if len(s.remoteWorkTracksCache) >= 64 {
		deleteOldestRemoteWorkTracksSnapshot(s.remoteWorkTracksCache)
	}
	s.remoteWorkTracksCache[key] = remoteWorkTracksSnapshot{Source: source, Work: work, Tracks: tracks, ExpiresAt: now.Add(2 * time.Minute)}
	s.remoteWorkCacheMu.Unlock()
	return source, work, tracks, nil
}

type remoteWorkCall struct {
	done   chan struct{}
	source remoteSourceForUse
	work   kikoeru.Work
	err    error
}

type remoteWorkTracksCall struct {
	done   chan struct{}
	source remoteSourceForUse
	work   kikoeru.Work
	tracks []kikoeru.Track
	err    error
}

func remoteWorkCacheKey(sourceID int64, code string) string {
	return fmt.Sprintf("%d:%s", sourceID, strings.ToUpper(strings.TrimSpace(code)))
}

func pruneRemoteWorkSnapshots(snapshots map[string]remoteWorkSnapshot, now time.Time) {
	for key, snapshot := range snapshots {
		if !now.Before(snapshot.ExpiresAt) {
			delete(snapshots, key)
		}
	}
}

func pruneRemoteWorkTracksSnapshots(snapshots map[string]remoteWorkTracksSnapshot, now time.Time) {
	for key, snapshot := range snapshots {
		if !now.Before(snapshot.ExpiresAt) {
			delete(snapshots, key)
		}
	}
}

func deleteOldestRemoteWorkSnapshot(snapshots map[string]remoteWorkSnapshot) {
	oldestKey := ""
	var oldestExpiry time.Time
	for key, snapshot := range snapshots {
		if oldestKey == "" || snapshot.ExpiresAt.Before(oldestExpiry) {
			oldestKey, oldestExpiry = key, snapshot.ExpiresAt
		}
	}
	if oldestKey != "" {
		delete(snapshots, oldestKey)
	}
}

func deleteOldestRemoteWorkTracksSnapshot(snapshots map[string]remoteWorkTracksSnapshot) {
	oldestKey := ""
	var oldestExpiry time.Time
	for key, snapshot := range snapshots {
		if oldestKey == "" || snapshot.ExpiresAt.Before(oldestExpiry) {
			oldestKey, oldestExpiry = key, snapshot.ExpiresAt
		}
	}
	if oldestKey != "" {
		delete(snapshots, oldestKey)
	}
}

func (s *Server) invalidateRemoteWorkCache(sourceID int64) {
	prefix := strconv.FormatInt(sourceID, 10) + ":"
	s.remoteWorkCacheMu.Lock()
	defer s.remoteWorkCacheMu.Unlock()
	for key := range s.remoteWorkCache {
		if strings.HasPrefix(key, prefix) {
			delete(s.remoteWorkCache, key)
		}
	}
	for key := range s.remoteWorkTracksCache {
		if strings.HasPrefix(key, prefix) {
			delete(s.remoteWorkTracksCache, key)
		}
	}
}

func (s *Server) resolveKikoeruWork(ctx context.Context, client *kikoeru.Client, code string) (kikoeru.Work, json.RawMessage, error) {
	remoteWork, rawWork, err := client.WorkInfo(ctx, code)
	if err == nil {
		return remoteWork, rawWork, nil
	}
	fallbackWork, fallbackRaw, fallbackErr := client.FindWorkByCode(ctx, code)
	if fallbackErr == nil {
		return fallbackWork, fallbackRaw, nil
	}
	return kikoeru.Work{}, nil, err
}

func isNotFoundLikeError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "404") || strings.Contains(message, "not found") || strings.Contains(message, "no rows")
}
