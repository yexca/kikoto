package httpapi

import (
	"context"
	"crypto/sha256"
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
	ID              int64
	Code            string
	DisplayName     string
	SourceType      string
	Enabled         bool
	Config          fileSourceConfig
	Endpoint        fileSourceEndpoint
	cacheGeneration uint64
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

func (s *Server) loadInstanceRemoteWorkTracks(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	languages := s.instanceMetadataLanguages(ctx)
	source, remoteWork, err := s.loadRemoteWork(ctx, sourceID, code, languages)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	tracks, err := s.loadRemoteTracks(ctx, source, remoteWork, languages)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	return source, remoteWork, tracks, nil
}

func (s *Server) loadRemoteWork(ctx context.Context, sourceID int64, code string, languages []string) (remoteSourceForUse, kikoeru.Work, error) {
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, kikoeru.Work{}, errRemoteSourceNotFound
		}
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return remoteSourceForUse{}, kikoeru.Work{}, errRemoteSourceNotUsable
	}
	client := s.kikoeruClientForSourceWithLanguages(source, sourceRequestInteractive, languages)
	remoteWork, _, err := s.resolveKikoeruWork(ctx, client, code)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		}
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	return source, remoteWork, nil
}

func (s *Server) loadRemoteTracks(ctx context.Context, source remoteSourceForUse, work kikoeru.Work, languages []string) ([]kikoeru.Track, error) {
	tracks, _, err := s.kikoeruClientForSourceWithLanguages(source, sourceRequestInteractive, languages).Tracks(ctx, work.ID)
	if err != nil {
		err = remoteWorkLookupError(err)
		if !errors.Is(err, errRemoteWorkNotFound) {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		}
		return nil, err
	}
	return tracks, nil
}

func (s *Server) loadRemoteWorkCached(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, error) {
	return s.loadRemoteWorkCachedWithLanguages(ctx, sourceID, code, s.viewerMetadataLanguages(ctx))
}

func (s *Server) loadRemoteWorkCachedWithLanguages(ctx context.Context, sourceID int64, code string, languages []string) (remoteSourceForUse, kikoeru.Work, error) {
	s.remoteSourceConfigMu.RLock()
	source, err := s.currentRemoteCacheSource(ctx, sourceID)
	if err != nil {
		s.remoteSourceConfigMu.RUnlock()
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	key := remoteWorkCacheKeyForLanguages(sourceID, code, languages)
	now := time.Now()
	s.remoteWorkCacheMu.Lock()
	snapshot, found := s.remoteWorkCache[key]
	if found && now.Before(snapshot.ExpiresAt) && sameRemoteCacheSource(snapshot.Source, source) {
		s.remoteWorkCacheMu.Unlock()
		s.remoteSourceConfigMu.RUnlock()
		return source, snapshot.Work, nil
	}
	if found {
		delete(s.remoteWorkCache, key)
	}
	if call := s.remoteWorkCacheCalls[key]; call != nil && sameRemoteCacheSource(call.source, source) {
		s.remoteWorkCacheMu.Unlock()
		s.remoteSourceConfigMu.RUnlock()
		select {
		case <-ctx.Done():
			return remoteSourceForUse{}, kikoeru.Work{}, ctx.Err()
		case <-call.done:
			if call.err == nil {
				if err := s.validateRemoteCacheResult(ctx, call.source); err != nil {
					return remoteSourceForUse{}, kikoeru.Work{}, err
				}
			}
			return call.source, call.work, call.err
		}
	}
	call := &remoteWorkCall{done: make(chan struct{}), source: source}
	s.remoteWorkCacheCalls[key] = call
	s.remoteWorkCacheMu.Unlock()
	s.remoteSourceConfigMu.RUnlock()

	client := s.kikoeruClientForSourceWithLanguages(source, sourceRequestInteractive, languages)
	work, _, err := s.resolveKikoeruWork(ctx, client, code)
	s.remoteSourceConfigMu.RLock()
	defer s.remoteSourceConfigMu.RUnlock()
	current, currentErr := s.currentRemoteCacheSource(ctx, sourceID)
	if currentErr != nil || !sameRemoteCacheSource(source, current) {
		err = errRemoteSourceChanged
	} else {
		s.recordRemoteCacheHealth(ctx, sourceID, err)
	}
	s.remoteWorkCacheMu.Lock()
	defer s.remoteWorkCacheMu.Unlock()
	if s.remoteWorkCacheCalls[key] != call {
		err = errRemoteSourceChanged
	} else {
		delete(s.remoteWorkCacheCalls, key)
	}
	call.work, call.err = work, err
	close(call.done)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	now = time.Now()
	pruneRemoteWorkSnapshots(s.remoteWorkCache, now)
	if len(s.remoteWorkCache) >= 64 {
		deleteOldestRemoteWorkSnapshot(s.remoteWorkCache)
	}
	s.remoteWorkCache[key] = remoteWorkSnapshot{Source: source, Work: work, ExpiresAt: now.Add(2 * time.Minute)}
	return source, work, nil
}

func (s *Server) loadRemoteWorkTracksCached(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	return s.loadRemoteWorkTracksCachedWithLanguages(ctx, sourceID, code, s.viewerMetadataLanguages(ctx))
}

// Fetch stores source metadata and directory entries for everyone, even when
// its initiating request carries a user's personal display preference. Resolve
// one instance priority for both upstream requests and their cache keys.
func (s *Server) loadInstanceRemoteWorkTracksCached(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	return s.loadRemoteWorkTracksCachedWithLanguages(ctx, sourceID, code, s.instanceMetadataLanguages(ctx))
}

func (s *Server) loadRemoteWorkTracksCachedWithLanguages(ctx context.Context, sourceID int64, code string, languages []string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	source, work, err := s.loadRemoteWorkCachedWithLanguages(ctx, sourceID, code, languages)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	s.remoteSourceConfigMu.RLock()
	current, err := s.currentRemoteCacheSource(ctx, sourceID)
	if err != nil || !sameRemoteCacheSource(source, current) {
		s.remoteSourceConfigMu.RUnlock()
		return remoteSourceForUse{}, kikoeru.Work{}, nil, errRemoteSourceChanged
	}
	key := remoteWorkCacheKeyForLanguages(sourceID, code, languages)
	now := time.Now()
	s.remoteWorkCacheMu.Lock()
	snapshot, found := s.remoteWorkTracksCache[key]
	if found && now.Before(snapshot.ExpiresAt) && sameRemoteCacheSource(snapshot.Source, source) && snapshot.Work.ID == work.ID {
		s.remoteWorkCacheMu.Unlock()
		s.remoteSourceConfigMu.RUnlock()
		return source, work, snapshot.Tracks, nil
	}
	if found {
		delete(s.remoteWorkTracksCache, key)
	}
	if call := s.remoteWorkTracksCacheCalls[key]; call != nil && sameRemoteCacheSource(call.source, source) && call.work.ID == work.ID {
		s.remoteWorkCacheMu.Unlock()
		s.remoteSourceConfigMu.RUnlock()
		select {
		case <-ctx.Done():
			return remoteSourceForUse{}, kikoeru.Work{}, nil, ctx.Err()
		case <-call.done:
			if call.err == nil {
				if err := s.validateRemoteCacheResult(ctx, call.source); err != nil {
					return remoteSourceForUse{}, kikoeru.Work{}, nil, err
				}
			}
			return call.source, call.work, call.tracks, call.err
		}
	}
	call := &remoteWorkTracksCall{done: make(chan struct{}), source: source, work: work}
	s.remoteWorkTracksCacheCalls[key] = call
	s.remoteWorkCacheMu.Unlock()
	s.remoteSourceConfigMu.RUnlock()

	tracks, _, err := s.kikoeruClientForSourceWithLanguages(source, sourceRequestInteractive, languages).Tracks(ctx, work.ID)
	err = remoteWorkLookupError(err)
	s.remoteSourceConfigMu.RLock()
	defer s.remoteSourceConfigMu.RUnlock()
	current, currentErr := s.currentRemoteCacheSource(ctx, sourceID)
	if currentErr != nil || !sameRemoteCacheSource(source, current) {
		err = errRemoteSourceChanged
	} else {
		s.recordRemoteCacheHealth(ctx, sourceID, err)
	}
	s.remoteWorkCacheMu.Lock()
	defer s.remoteWorkCacheMu.Unlock()
	if s.remoteWorkTracksCacheCalls[key] != call {
		err = errRemoteSourceChanged
	} else {
		delete(s.remoteWorkTracksCacheCalls, key)
	}
	call.tracks, call.err = tracks, err
	close(call.done)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	now = time.Now()
	pruneRemoteWorkTracksSnapshots(s.remoteWorkTracksCache, now)
	if len(s.remoteWorkTracksCache) >= 64 {
		deleteOldestRemoteWorkTracksSnapshot(s.remoteWorkTracksCache)
	}
	s.remoteWorkTracksCache[key] = remoteWorkTracksSnapshot{Source: source, Work: work, Tracks: tracks, ExpiresAt: now.Add(2 * time.Minute)}
	return source, work, tracks, nil
}

var errRemoteSourceChanged = errors.New("remote source configuration changed; retry the request")

// Called after validating the configuration under remoteSourceConfigMu, so an
// obsolete request cannot change the health of the newly configured source.
func (s *Server) recordRemoteCacheHealth(ctx context.Context, sourceID int64, requestErr error) {
	if requestErr == nil {
		_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	} else if !errors.Is(requestErr, sql.ErrNoRows) {
		_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
	}
}

// Called under remoteSourceConfigMu. Cached data never grants permission to use
// an old endpoint, disabled source or obsolete outbound policy.
func (s *Server) currentRemoteCacheSource(ctx context.Context, id int64) (remoteSourceForUse, error) {
	source, err := s.loadRemoteSourceForUse(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, errRemoteSourceNotFound
		}
		return remoteSourceForUse{}, err
	}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		return remoteSourceForUse{}, errRemoteSourceNotUsable
	}
	s.remoteWorkCacheMu.Lock()
	source.cacheGeneration = s.remoteWorkCacheGenerations[id]
	s.remoteWorkCacheMu.Unlock()
	return source, nil
}

// requireUsableRemoteSource rejects a source id that does not exist or cannot
// serve works, before any provider or source request is made on its behalf.
func (s *Server) requireUsableRemoteSource(ctx context.Context, id int64) error {
	s.remoteSourceConfigMu.RLock()
	defer s.remoteSourceConfigMu.RUnlock()
	_, err := s.currentRemoteCacheSource(ctx, id)
	return err
}

func sameRemoteCacheSource(a, b remoteSourceForUse) bool {
	aJSON, _ := json.Marshal(a)
	bJSON, _ := json.Marshal(b)
	return a.cacheGeneration == b.cacheGeneration && sha256.Sum256(aJSON) == sha256.Sum256(bJSON)
}

func (s *Server) validateRemoteCacheResult(ctx context.Context, source remoteSourceForUse) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.remoteSourceConfigMu.RLock()
	defer s.remoteSourceConfigMu.RUnlock()
	current, err := s.currentRemoteCacheSource(ctx, source.ID)
	if err != nil || !sameRemoteCacheSource(source, current) {
		return errRemoteSourceChanged
	}
	return nil
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

// remoteWorkCacheKey separates viewers with different metadata languages,
// because the source may answer each language differently. The source id
// stays the key prefix for invalidateRemoteWorkCache.
func (s *Server) remoteWorkCacheKey(ctx context.Context, sourceID int64, code string) string {
	return remoteWorkCacheKeyForLanguages(sourceID, code, s.viewerMetadataLanguages(ctx))
}

func remoteWorkCacheKeyForLanguages(sourceID int64, code string, languages []string) string {
	return fmt.Sprintf("%d:%s:%s", sourceID, strings.ToUpper(strings.TrimSpace(code)), strings.Join(languages, ","))
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
	s.remoteWorkCacheGenerations[sourceID]++
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
	for key := range s.remoteWorkCacheCalls {
		if strings.HasPrefix(key, prefix) {
			delete(s.remoteWorkCacheCalls, key)
		}
	}
	for key := range s.remoteWorkTracksCacheCalls {
		if strings.HasPrefix(key, prefix) {
			delete(s.remoteWorkTracksCacheCalls, key)
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
	// Only a source that answered both lookups can say the work is absent. A
	// listing it could not serve leaves the question open, which is a failure.
	if kikoeru.IsNotFound(err) && errors.Is(fallbackErr, kikoeru.ErrWorkNotFound) {
		return kikoeru.Work{}, nil, errRemoteWorkNotFound
	}
	return kikoeru.Work{}, nil, err
}

// remoteWorkLookupError turns the source's own "no such work" answer for a
// work it has already resolved into errRemoteWorkNotFound.
func remoteWorkLookupError(err error) error {
	if kikoeru.IsNotFound(err) {
		return errRemoteWorkNotFound
	}
	return err
}

func isNotFoundLikeError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "404") || strings.Contains(message, "not found") || strings.Contains(message, "no rows")
}
