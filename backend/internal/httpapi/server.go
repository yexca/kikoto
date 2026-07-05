package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type Server struct {
	db  *sql.DB
	cfg config.Config
}

func NewServer(db *sql.DB, cfg config.Config) *Server {
	return &Server{db: db, cfg: cfg}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /api/auth/me", s.getCurrentUser)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("GET /api/users", s.listUsers)
	mux.HandleFunc("POST /api/users", s.createUser)
	mux.HandleFunc("PATCH /api/users/{id}", s.updateUser)
	mux.HandleFunc("DELETE /api/users/{id}", s.deleteUser)
	mux.HandleFunc("GET /api/works", s.listWorks)
	mux.HandleFunc("GET /api/works/{id}", s.getWork)
	mux.HandleFunc("GET /api/works/{code}/resolve", s.resolveWorkCode)
	mux.HandleFunc("GET /api/works/{code}/source-availability", s.getWorkSourceAvailability)
	mux.HandleFunc("PATCH /api/works/{id}/user-state", s.updateWorkUserState)
	mux.HandleFunc("GET /api/circles", s.listCircles)
	mux.HandleFunc("GET /api/circles/{externalId}", s.getCircle)
	mux.HandleFunc("PATCH /api/circles/{externalId}/user-state", s.updateCircleUserState)
	mux.HandleFunc("POST /api/circles/{externalId}/refresh", s.refreshCircle)
	mux.HandleFunc("DELETE /api/circles/{externalId}/catalog/{code}", s.deleteCircleCatalogWork)
	mux.HandleFunc("GET /api/voices", s.listVoices)
	mux.HandleFunc("GET /api/voices/{personId}", s.getVoice)
	mux.HandleFunc("GET /api/voices/{personId}/alias-candidates", s.listVoiceAliasCandidates)
	mux.HandleFunc("POST /api/voices/{personId}/aliases", s.createVoiceAlias)
	mux.HandleFunc("DELETE /api/voices/{personId}/aliases/{aliasId}", s.deleteVoiceAlias)
	mux.HandleFunc("POST /api/voices/{personId}/merge", s.mergeVoiceAliasCandidate)
	mux.HandleFunc("GET /api/voices/{personId}/merges", s.listVoiceMergeReviews)
	mux.HandleFunc("POST /api/voices/{personId}/merges/{mergeId}/undo", s.undoVoiceMergeReview)
	mux.HandleFunc("PATCH /api/voices/{personId}/user-state", s.updateVoiceUserState)
	mux.HandleFunc("PUT /api/voices/{personId}/tags", s.setVoiceUserTags)
	mux.HandleFunc("GET /api/assets/covers/{file}", s.getCoverAsset)
	mux.HandleFunc("GET /api/media/{id}/stream", s.streamMedia)
	mux.HandleFunc("POST /api/media/{id}/cache", s.cacheMediaLocation)
	mux.HandleFunc("DELETE /api/media/{id}/cache", s.deleteMediaCacheLocation)
	mux.HandleFunc("DELETE /api/media/{id}/local", s.deleteMediaLocalLocation)
	mux.HandleFunc("GET /api/media/{id}/asset", s.serveMediaAsset)
	mux.HandleFunc("GET /api/media/{id}/text", s.serveMediaText)
	mux.HandleFunc("PATCH /api/media-items/{id}/progress", s.updateMediaProgress)
	mux.HandleFunc("GET /api/settings", s.getSettings)
	mux.HandleFunc("GET /api/runtime-settings", s.getRuntimeSettings)
	mux.HandleFunc("PATCH /api/settings", s.updateSettings)
	mux.HandleFunc("GET /api/library-sources", s.listLibrarySources)
	mux.HandleFunc("GET /api/file-sources", s.listFileSources)
	mux.HandleFunc("POST /api/file-sources", s.createFileSource)
	mux.HandleFunc("PATCH /api/file-sources/{id}", s.updateFileSource)
	mux.HandleFunc("DELETE /api/file-sources/{id}", s.deleteFileSource)
	mux.HandleFunc("GET /api/remote-sources/{id}/works", s.listRemoteSourceWorks)
	mux.HandleFunc("GET /api/remote-sources/{id}/works/{code}", s.getRemoteSourceWork)
	mux.HandleFunc("POST /api/remote-sources/{id}/works/{code}/save-plan", s.planRemoteSourceWorkSave)
	mux.HandleFunc("POST /api/remote-sources/{id}/works/{code}/save", s.saveRemoteSourceWork)
	mux.HandleFunc("POST /api/remote-sources/{id}/works/{code}/sync", s.syncRemoteSourceWork)
	mux.HandleFunc("POST /api/remote-sources/{id}/works/{code}/cache", s.cacheRemoteSourceWorkMedia)
	mux.HandleFunc("GET /api/workflow-definitions", s.listWorkflowDefinitions)
	mux.HandleFunc("POST /api/workflow-definitions", s.createWorkflowDefinition)
	mux.HandleFunc("PATCH /api/workflow-definitions/{id}", s.updateWorkflowDefinition)
	mux.HandleFunc("DELETE /api/workflow-definitions/{id}", s.deleteWorkflowDefinition)
	mux.HandleFunc("GET /api/workflow-triggers", s.listWorkflowTriggers)
	mux.HandleFunc("POST /api/workflow-triggers", s.createWorkflowTrigger)
	mux.HandleFunc("PATCH /api/workflow-triggers/{id}", s.updateWorkflowTrigger)
	mux.HandleFunc("DELETE /api/workflow-triggers/{id}", s.deleteWorkflowTrigger)
	mux.HandleFunc("GET /api/workflow-runs", s.listWorkflowRuns)
	mux.HandleFunc("GET /api/workflow-runs/{id}", s.getWorkflowRun)
	mux.HandleFunc("POST /api/workflow-runs/local-scan", s.createLocalScanRun)
	mux.HandleFunc("POST /api/workflow-runs/remote-bulk", s.createRemoteBulkRun)
	mux.HandleFunc("POST /api/workflow-runs/dlsite-sync", s.createDLsiteSyncRun)
	return withCORS(s.authMiddleware(mux))
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) getCurrentUser(w http.ResponseWriter, r *http.Request) {
	user, ok := userFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": user})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	username, password, err := parseLoginRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var userID int64
	var passwordHash string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT account.id, credential.password_hash
		FROM user_account AS account
		INNER JOIN user_password_credential AS credential ON credential.user_id = account.id
		WHERE account.username = ? AND account.enabled = 1
	`, username).Scan(&userID, &passwordHash); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}
	if !verifyPassword(password, passwordHash) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}

	sessionID, err := newSessionID()
	if err != nil {
		writeError(w, err)
		return
	}
	expiresAt := time.Now().Add(30 * 24 * time.Hour).UTC()
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_session (id, user_id, expires_at)
		VALUES (?, ?, ?)
	`, sessionID, userID, expiresAt.Format("2006-01-02 15:04:05")); err != nil {
		writeError(w, err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionID,
		Path:     "/",
		Expires:  expiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	user, err := s.loadUserByID(r.Context(), userID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": user})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		_, _ = s.db.ExecContext(r.Context(), "DELETE FROM user_session WHERE id = ?", cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) getCoverAsset(w http.ResponseWriter, r *http.Request) {
	file := filepath.Base(r.PathValue("file"))
	if file == "." || file == string(filepath.Separator) || strings.Contains(file, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid cover file"})
		return
	}
	path := filepath.Join(s.cfg.CacheRoot, "cover", file)
	http.ServeFile(w, r, path)
}

func (s *Server) listWorks(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if err := s.ensureCircleSchema(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			work.id,
			work.primary_code,
			work.title,
			work.created_at,
			(
				SELECT COUNT(*)
				FROM media_item
				WHERE media_item.work_id = work.id
					AND media_item.kind = 'audio'
			) AS track_count,
			(
				SELECT COUNT(*)
				FROM media_file_location
				INNER JOIN media_item ON media_item.id = media_file_location.media_item_id
				WHERE media_item.work_id = work.id
					AND media_item.kind = 'audio'
					AND media_file_location.availability = 'available'
			) AS available_locations,
			(
				SELECT GROUP_CONCAT(DISTINCT media_file_location.location_type)
				FROM media_file_location
				INNER JOIN media_item ON media_item.id = media_file_location.media_item_id
				WHERE media_item.work_id = work.id
					AND media_file_location.availability = 'available'
			) AS available_location_types,
			(
				SELECT snapshot_json
				FROM metadata_snapshot
				INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id
				WHERE metadata_snapshot.work_id = work.id
					AND metadata_provider.code = 'dlsite'
				ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC
				LIMIT 1
			) AS snapshot_json,
			(
				SELECT party.display_name || '|' || external.external_id
				FROM work_party AS relation
				INNER JOIN party ON party.id = relation.party_id
				LEFT JOIN party_external_id AS external ON external.party_id = party.id
					AND external.is_primary = 1
				WHERE relation.work_id = work.id
					AND relation.role = 'circle'
				ORDER BY relation.updated_at DESC
				LIMIT 1
			) AS party_link,
			COALESCE(user_work_state.listening_status, 'none') AS listening_status,
			COALESCE(user_work_state.favorite, 0) AS favorite
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id
			AND user_work_state.user_id = ?
		ORDER BY work.created_at DESC
		LIMIT 100
	`, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	type work struct {
		ID                 int64    `json:"id"`
		PrimaryCode        string   `json:"primaryCode"`
		Title              string   `json:"title"`
		CreatedAt          string   `json:"createdAt"`
		UpdatedAt          string   `json:"updatedAt"`
		ReleaseDate        *string  `json:"releaseDate"`
		CoverURL           string   `json:"coverUrl"`
		DLsiteURL          string   `json:"dlsiteUrl"`
		Circle             string   `json:"circle"`
		CircleExternalID   string   `json:"circleExternalId"`
		Rating             *float64 `json:"rating"`
		Sales              *int64   `json:"sales"`
		Tags               []string `json:"tags"`
		VoiceActors        []string `json:"voiceActors"`
		TrackCount         int64    `json:"trackCount"`
		AvailableLocations int64    `json:"availableLocations"`
		Availability       []string `json:"availability"`
		ListeningStatus    string   `json:"listeningStatus"`
		Favorite           bool     `json:"favorite"`
	}

	works := []work{}
	for rows.Next() {
		var item work
		var snapshot sql.NullString
		var availableLocationTypes sql.NullString
		var partyLink sql.NullString
		var favorite int
		if err := rows.Scan(
			&item.ID,
			&item.PrimaryCode,
			&item.Title,
			&item.CreatedAt,
			&item.TrackCount,
			&item.AvailableLocations,
			&availableLocationTypes,
			&snapshot,
			&partyLink,
			&item.ListeningStatus,
			&favorite,
		); err != nil {
			writeError(w, err)
			return
		}
		item.Favorite = favorite != 0
		metadata := parseDLsiteSnapshot(snapshot.String)
		item.ReleaseDate = metadata.ReleaseDate
		item.UpdatedAt = item.CreatedAt
		item.CoverURL = s.coverURL(item.PrimaryCode)
		item.DLsiteURL = dlsiteURL(item.PrimaryCode)
		item.Circle = metadata.Circle
		item.CircleExternalID = metadata.CircleExternalID
		if name, externalID := parsePartyLink(partyLink.String); name != "" {
			item.Circle = name
			item.CircleExternalID = externalID
		}
		item.Rating = metadata.Rating
		item.Sales = metadata.Sales
		item.Tags = metadata.Tags
		item.VoiceActors = metadata.VoiceActors
		item.Availability = availabilityBadges(availableLocationTypes.String)
		works = append(works, item)
	}

	writeJSON(w, http.StatusOK, works)
}

type workDetail struct {
	ID               int64             `json:"id"`
	PrimaryCode      string            `json:"primaryCode"`
	BaseCode         string            `json:"baseCode"`
	MetadataLanguage string            `json:"metadataLanguage"`
	WorkType         string            `json:"workType"`
	Title            string            `json:"title"`
	TitleKana        string            `json:"titleKana"`
	Description      string            `json:"description"`
	ReleaseDate      *string           `json:"releaseDate"`
	AgeRating        string            `json:"ageRating"`
	DurationSeconds  *int64            `json:"durationSeconds"`
	CreatedAt        string            `json:"createdAt"`
	UpdatedAt        string            `json:"updatedAt"`
	CoverURL         string            `json:"coverUrl"`
	DLsiteURL        string            `json:"dlsiteUrl"`
	Circle           string            `json:"circle"`
	CircleExternalID string            `json:"circleExternalId"`
	Rating           *float64          `json:"rating"`
	RatingCount      *int64            `json:"ratingCount"`
	Sales            *int64            `json:"sales"`
	Series           string            `json:"series"`
	DLsiteFetchedAt  string            `json:"dlsiteFetchedAt"`
	Tags             []string          `json:"tags"`
	VoiceActors      []string          `json:"voiceActors"`
	VoiceCredits     []voiceCredit     `json:"voiceCredits"`
	ListeningStatus  string            `json:"listeningStatus"`
	Favorite         bool              `json:"favorite"`
	Translations     []workTranslation `json:"translations"`
	MediaItems       []mediaItemDetail `json:"mediaItems"`
}

type workTranslation struct {
	WorkID           *int64 `json:"workId"`
	PrimaryCode      string `json:"primaryCode"`
	Title            string `json:"title"`
	MetadataLanguage string `json:"metadataLanguage"`
	Current          bool   `json:"current"`
}

type workResolveResponse struct {
	RequestedCode string `json:"requestedCode"`
	ResolvedCode  string `json:"resolvedCode"`
	WorkID        int64  `json:"workId"`
	BaseCode      string `json:"baseCode"`
	IsTranslation bool   `json:"isTranslation"`
}

type voiceCredit struct {
	PersonID    int64  `json:"personId"`
	DisplayName string `json:"displayName"`
}

type mediaItemDetail struct {
	ID              int64                `json:"id"`
	ParentID        *int64               `json:"parentId"`
	Kind            string               `json:"kind"`
	Title           string               `json:"title"`
	DiscNo          *int64               `json:"discNo"`
	TrackNo         *int64               `json:"trackNo"`
	DurationSeconds *int64               `json:"durationSeconds"`
	SizeBytes       *int64               `json:"sizeBytes"`
	Fingerprint     string               `json:"fingerprint"`
	Progress        *mediaProgressDetail `json:"progress"`
	Locations       []fileLocationDetail `json:"locations"`
}

type fileLocationDetail struct {
	ID              int64   `json:"id"`
	FileSourceID    int64   `json:"fileSourceId"`
	FileSourceCode  string  `json:"fileSourceCode"`
	FileSourceName  string  `json:"fileSourceName"`
	LocationType    string  `json:"locationType"`
	Path            string  `json:"path"`
	StreamURL       string  `json:"streamUrl"`
	DownloadURL     string  `json:"downloadUrl"`
	RemoteHash      string  `json:"remoteHash"`
	SizeBytes       *int64  `json:"sizeBytes"`
	DurationSeconds *int64  `json:"durationSeconds"`
	Availability    string  `json:"availability"`
	LastCheckedAt   *string `json:"lastCheckedAt"`
}

func (s *Server) getWork(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}

	work, err := s.loadWorkDetail(r.Context(), user.ID, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, work)
}

func (s *Server) resolveWorkCode(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	code := normalizeDLsiteCode(r.PathValue("code"))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return
	}
	resolved, err := s.resolveWorkCodeDetail(r.Context(), code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resolved)
}

func (s *Server) streamMedia(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "playback:use"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}

	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, id).Scan(&locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "media location not found"})
			return
		}
		writeError(w, err)
		return
	}

	if (locationType != "local" && locationType != "cache") || availability != "available" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media location is not available"})
		return
	}

	root := s.cfg.DataRoot
	if locationType == "cache" {
		root = s.cfg.CacheRoot
	}
	path, err := safeDataPath(root, relPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media path"})
		return
	}
	http.ServeFile(w, r, path)
}

type mediaCacheResult struct {
	RunID       int64  `json:"runId"`
	JobID       int64  `json:"jobId"`
	LocationID  int64  `json:"locationId"`
	CachePath   string `json:"cachePath"`
	Status      string `json:"status"`
	AlreadyDone bool   `json:"alreadyDone"`
}

func (s *Server) cacheMediaLocation(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "playback:use"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	result, err := s.runRemoteMediaCache(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) deleteMediaCacheLocation(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	result, err := s.runMediaCacheCleanup(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) deleteMediaLocalLocation(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	result, err := s.runLocalMediaDelete(r.Context(), id)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) serveMediaAsset(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	path, _, err := s.localMediaPath(r, r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	http.ServeFile(w, r, path)
}

func (s *Server) serveMediaText(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	path, relPath, err := s.localMediaPath(r, r.PathValue("id"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if !isTextFile(relPath) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "media location is not a text file"})
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media file is not available"})
		return
	}
	if info.Size() > 512*1024 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text file is too large to preview"})
		return
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    filepath.ToSlash(relPath),
		"content": string(bytes),
	})
}

func (s *Server) localMediaPath(r *http.Request, idValue string) (string, string, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(idValue), 10, 64)
	if err != nil || id <= 0 {
		return "", "", fmt.Errorf("invalid media location id")
	}
	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, id).Scan(&locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("media location not found")
		}
		return "", "", err
	}
	if locationType != "local" || availability != "available" {
		return "", "", fmt.Errorf("media location is not available")
	}
	path, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		return "", "", fmt.Errorf("invalid media path")
	}
	return path, relPath, nil
}

func (s *Server) runRemoteMediaCache(ctx context.Context, remoteLocationID int64) (mediaCacheResult, error) {
	var mediaItemID int64
	var workCode string
	var sourceID int64
	var sourceCode string
	var sourceName string
	var sourceConfigJSON string
	var locationType string
	var remotePath string
	var streamURL string
	var downloadURL string
	var remoteHash string
	var sizeBytes sql.NullInt64
	var durationSeconds sql.NullInt64
	var availability string
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			location.media_item_id,
			work.primary_code,
			source.id,
			source.code,
			source.display_name,
			source.config_json,
			location.location_type,
			location.path,
			location.stream_url,
			location.download_url,
			location.remote_hash,
			location.size_bytes,
			location.duration_seconds,
			location.availability
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		WHERE location.id = ?
	`, remoteLocationID).Scan(
		&mediaItemID,
		&workCode,
		&sourceID,
		&sourceCode,
		&sourceName,
		&sourceConfigJSON,
		&locationType,
		&remotePath,
		&streamURL,
		&downloadURL,
		&remoteHash,
		&sizeBytes,
		&durationSeconds,
		&availability,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaCacheResult{}, fmt.Errorf("media location not found")
		}
		return mediaCacheResult{}, err
	}
	if locationType != "remote_stream" || availability != "available" {
		return mediaCacheResult{}, fmt.Errorf("media location is not an available remote stream")
	}
	var sourceConfig fileSourceConfig
	_ = json.Unmarshal([]byte(sourceConfigJSON), &sourceConfig)
	if !s.settingBoolContext(ctx, "remote_cache_enabled", false) && !(sourceConfig.CacheEnabled != nil && *sourceConfig.CacheEnabled) {
		return mediaCacheResult{}, fmt.Errorf("remote cache is not enabled")
	}
	cacheRelPath := cacheMediaRelPath(sourceCode, workCode, remotePath)
	if cacheID, ok, err := s.findAvailableCacheLocation(ctx, mediaItemID, sourceID, cacheRelPath); err != nil {
		return mediaCacheResult{}, err
	} else if ok {
		return mediaCacheResult{LocationID: cacheID, CachePath: cacheRelPath, Status: "succeeded", AlreadyDone: true}, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return mediaCacheResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "media_cache", "Cache media", "Select media items, filter cache misses, sync source state, and materialize cache files.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "sync", "type": "sync_file_locations"},
			{"id": "filter", "type": "filter_candidates"},
			{"id": "cache", "type": "materialize_cache"},
		},
	})
	if err != nil {
		return mediaCacheResult{}, err
	}
	runInput := map[string]any{"media_location_id": remoteLocationID, "media_item_id": mediaItemID, "source_id": sourceID, "source_code": sourceCode, "work_code": workCode}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "media_cache", "Cache media", "running", "playback", "auto_cache_on_play", runInput, map[string]any{"cache_path": cacheRelPath})
	if err != nil {
		return mediaCacheResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select media item", Position: 1, Status: "succeeded",
		Input: runInput, Output: map[string]any{"media_item_id": mediaItemID, "remote_location_id": remoteLocationID},
	}); err != nil {
		return mediaCacheResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync remote location", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": workCode, "source_id": sourceID}, Output: map[string]any{"remote_location_id": remoteLocationID},
	}); err != nil {
		return mediaCacheResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter cache miss", Position: 3, Status: "succeeded",
		Input: map[string]any{"cache_path": cacheRelPath}, Output: map[string]any{"cache_missing": true},
	}); err != nil {
		return mediaCacheResult{}, err
	}
	cacheNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cache", NodeType: "materialize_cache", DisplayName: "Materialize cache file", Position: 4, Status: "running",
		Input: map[string]any{"download_url": firstNonEmpty(downloadURL, streamURL), "cache_path": cacheRelPath}, Output: nil,
	})
	if err != nil {
		return mediaCacheResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cacheNodeID, WorkerType: "remote_media_cache", Status: "running", Payload: runInput, ProgressCurrent: 0, ProgressTotal: 1,
	})
	if err != nil {
		return mediaCacheResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return mediaCacheResult{}, err
	}

	targetPath := filepath.Join(s.cfg.CacheRoot, filepath.FromSlash(cacheRelPath))
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		_ = s.finishMediaCacheRun(ctx, runID, cacheNodeID, jobID, "failed", cacheRelPath, err.Error(), 0)
		return mediaCacheResult{}, err
	}
	written, err := s.downloadToFile(ctx, firstNonEmpty(downloadURL, streamURL), targetPath)
	if err != nil {
		_ = s.finishMediaCacheRun(ctx, runID, cacheNodeID, jobID, "failed", cacheRelPath, err.Error(), 0)
		return mediaCacheResult{}, err
	}
	cacheLocationID, err := s.upsertCacheLocation(ctx, mediaItemID, sourceID, cacheRelPath, remoteHash, nullableInt64(sizeBytes), nullableInt64(durationSeconds), written)
	if err != nil {
		_ = s.finishMediaCacheRun(ctx, runID, cacheNodeID, jobID, "failed", cacheRelPath, err.Error(), 0)
		return mediaCacheResult{}, err
	}
	if err := s.finishMediaCacheRun(ctx, runID, cacheNodeID, jobID, "succeeded", cacheRelPath, "", written); err != nil {
		return mediaCacheResult{}, err
	}
	_ = sourceName
	return mediaCacheResult{RunID: runID, JobID: jobID, LocationID: cacheLocationID, CachePath: cacheRelPath, Status: "succeeded"}, nil
}

func (s *Server) findAvailableCacheLocation(ctx context.Context, mediaItemID int64, sourceID int64, cacheRelPath string) (int64, bool, error) {
	var id int64
	var path string
	if err := s.db.QueryRowContext(ctx, `
		SELECT id, path
		FROM media_file_location
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
			AND availability = 'available'
	`, mediaItemID, sourceID, cacheRelPath).Scan(&id, &path); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, false, nil
		}
		return 0, false, err
	}
	if _, err := os.Stat(filepath.Join(s.cfg.CacheRoot, filepath.FromSlash(path))); err != nil {
		return 0, false, nil
	}
	return id, true, nil
}

func (s *Server) upsertCacheLocation(ctx context.Context, mediaItemID int64, sourceID int64, cacheRelPath string, remoteHash string, sizeBytes *int64, durationSeconds *int64, written int64) (int64, error) {
	sizeValue := any(sizeBytes)
	if sizeBytes == nil && written > 0 {
		sizeValue = written
	}
	var durationValue any
	if durationSeconds != nil {
		durationValue = *durationSeconds
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO media_file_location (
			media_item_id,
			file_source_id,
			location_type,
			path,
			remote_hash,
			size_bytes,
			duration_seconds,
			availability,
			last_checked_at
		)
		SELECT ?, ?, 'cache', ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'cache'
				AND path = ?
		)
	`, mediaItemID, sourceID, cacheRelPath, remoteHash, sizeValue, durationValue, mediaItemID, sourceID, cacheRelPath); err != nil {
		return 0, err
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET remote_hash = ?,
			size_bytes = ?,
			duration_seconds = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
	`, remoteHash, sizeValue, durationValue, mediaItemID, sourceID, cacheRelPath); err != nil {
		return 0, err
	}
	var id int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id
		FROM media_file_location
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
	`, mediaItemID, sourceID, cacheRelPath).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *Server) finishMediaCacheRun(ctx context.Context, runID int64, nodeID int64, jobID int64, status string, cacheRelPath string, errorMessage string, written int64) error {
	output := mustJSON(map[string]any{"cache_path": cacheRelPath, "bytes": written})
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?,
			output_json = ?,
			error_message = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, output, errorMessage, nodeID); err != nil {
		return err
	}
	progress := 1
	if status != "succeeded" {
		progress = 0
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?,
			progress_current = ?,
			progress_total = 1,
			error_message = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, progress, errorMessage, jobID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = ?,
			summary_json = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, output, runID); err != nil {
		return err
	}
	return nil
}

type mediaCacheDeleteResult struct {
	RunID      int64  `json:"runId"`
	LocationID int64  `json:"locationId"`
	CachePath  string `json:"cachePath"`
	Status     string `json:"status"`
	Deleted    bool   `json:"deleted"`
}

type mediaLocalDeleteResult struct {
	RunID             int64  `json:"runId"`
	LocationID        int64  `json:"locationId"`
	WorkID            int64  `json:"workId"`
	Path              string `json:"path"`
	Status            string `json:"status"`
	Deleted           bool   `json:"deleted"`
	ClearedProgress   int64  `json:"clearedProgress"`
	ClearedWorkStates int64  `json:"clearedWorkStates"`
}

func (s *Server) runMediaCacheCleanup(ctx context.Context, cacheLocationID int64) (mediaCacheDeleteResult, error) {
	var mediaItemID int64
	var sourceID int64
	var locationType string
	var cachePath string
	var availability string
	if err := s.db.QueryRowContext(ctx, `
		SELECT media_item_id, file_source_id, location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, cacheLocationID).Scan(&mediaItemID, &sourceID, &locationType, &cachePath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaCacheDeleteResult{}, fmt.Errorf("cache location not found")
		}
		return mediaCacheDeleteResult{}, err
	}
	if locationType != "cache" {
		return mediaCacheDeleteResult{}, fmt.Errorf("media location is not a cache file")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return mediaCacheDeleteResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "media_cache_cleanup", "Clean media cache", "Delete cached media files and mark cache locations unavailable.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "cleanup", "type": "cleanup_cache"},
		},
	})
	if err != nil {
		return mediaCacheDeleteResult{}, err
	}
	input := map[string]any{"cache_location_id": cacheLocationID, "media_item_id": mediaItemID, "source_id": sourceID, "cache_path": cachePath}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "media_cache_cleanup", "Clean media cache", "running", "manual", "delete_cache", input, map[string]any{"cache_path": cachePath})
	if err != nil {
		return mediaCacheDeleteResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select cached media", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"availability": availability},
	}); err != nil {
		return mediaCacheDeleteResult{}, err
	}
	cleanupNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cleanup", NodeType: "cleanup_cache", DisplayName: "Delete cache file", Position: 2, Status: "running",
		Input: input, Output: nil,
	})
	if err != nil {
		return mediaCacheDeleteResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return mediaCacheDeleteResult{}, err
	}

	deleted := false
	targetPath := filepath.Join(s.cfg.CacheRoot, filepath.FromSlash(cachePath))
	if err := os.Remove(targetPath); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			_ = s.finishMediaCacheCleanup(ctx, runID, cleanupNodeID, "failed", cacheLocationID, cachePath, false, err.Error())
			return mediaCacheDeleteResult{}, err
		}
	} else {
		deleted = true
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND location_type = 'cache'
	`, cacheLocationID); err != nil {
		_ = s.finishMediaCacheCleanup(ctx, runID, cleanupNodeID, "failed", cacheLocationID, cachePath, deleted, err.Error())
		return mediaCacheDeleteResult{}, err
	}
	if err := s.finishMediaCacheCleanup(ctx, runID, cleanupNodeID, "succeeded", cacheLocationID, cachePath, deleted, ""); err != nil {
		return mediaCacheDeleteResult{}, err
	}
	return mediaCacheDeleteResult{RunID: runID, LocationID: cacheLocationID, CachePath: cachePath, Status: "succeeded", Deleted: deleted}, nil
}

func (s *Server) runLocalMediaDelete(ctx context.Context, localLocationID int64) (mediaLocalDeleteResult, error) {
	var mediaItemID int64
	var workID int64
	var sourceID int64
	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.media_item_id, item.work_id, location.file_source_id, location.location_type, location.path, location.availability
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
	`, localLocationID).Scan(&mediaItemID, &workID, &sourceID, &locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return mediaLocalDeleteResult{}, fmt.Errorf("local media location not found")
		}
		return mediaLocalDeleteResult{}, err
	}
	if locationType != "local" {
		return mediaLocalDeleteResult{}, fmt.Errorf("media location is not a local file")
	}
	targetPath, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_media_delete", "Delete local media", "Delete local media files and clear playback state for the work.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_media_items"},
			{"id": "delete", "type": "materialize_save"},
			{"id": "cleanup", "type": "cleanup_cache"},
		},
	})
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	input := map[string]any{"local_location_id": localLocationID, "media_item_id": mediaItemID, "work_id": workID, "source_id": sourceID, "path": relPath}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "local_media_delete", "Delete local media", "running", "manual", "delete_local", input, map[string]any{"path": relPath})
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_media_items", DisplayName: "Select local media", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"availability": availability},
	}); err != nil {
		return mediaLocalDeleteResult{}, err
	}
	deleteNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "delete", NodeType: "materialize_save", DisplayName: "Delete local file", Position: 2, Status: "running",
		Input: input, Output: nil,
	})
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	cleanupNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cleanup", NodeType: "cleanup_cache", DisplayName: "Clear playback state", Position: 3, Status: "queued",
		Input: map[string]any{"work_id": workID}, Output: nil,
	})
	if err != nil {
		return mediaLocalDeleteResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return mediaLocalDeleteResult{}, err
	}

	deleted := false
	if err := os.Remove(targetPath); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			_ = s.finishLocalMediaDelete(ctx, runID, deleteNodeID, cleanupNodeID, "failed", localLocationID, relPath, deleted, 0, 0, err.Error())
			return mediaLocalDeleteResult{}, err
		}
	} else {
		deleted = true
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE id = ?
			AND location_type = 'local'
	`, localLocationID); err != nil {
		_ = s.finishLocalMediaDelete(ctx, runID, deleteNodeID, cleanupNodeID, "failed", localLocationID, relPath, deleted, 0, 0, err.Error())
		return mediaLocalDeleteResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"deleted": deleted, "path": relPath}), deleteNodeID); err != nil {
		return mediaLocalDeleteResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", cleanupNodeID); err != nil {
		return mediaLocalDeleteResult{}, err
	}
	progressResult, err := s.db.ExecContext(ctx, `
		DELETE FROM user_media_progress
		WHERE media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
	`, workID)
	if err != nil {
		_ = s.finishLocalMediaDelete(ctx, runID, deleteNodeID, cleanupNodeID, "failed", localLocationID, relPath, deleted, 0, 0, err.Error())
		return mediaLocalDeleteResult{}, err
	}
	stateResult, err := s.db.ExecContext(ctx, "DELETE FROM user_work_state WHERE work_id = ?", workID)
	if err != nil {
		_ = s.finishLocalMediaDelete(ctx, runID, deleteNodeID, cleanupNodeID, "failed", localLocationID, relPath, deleted, 0, 0, err.Error())
		return mediaLocalDeleteResult{}, err
	}
	clearedProgress, _ := progressResult.RowsAffected()
	clearedStates, _ := stateResult.RowsAffected()
	if err := s.finishLocalMediaDelete(ctx, runID, deleteNodeID, cleanupNodeID, "succeeded", localLocationID, relPath, deleted, clearedProgress, clearedStates, ""); err != nil {
		return mediaLocalDeleteResult{}, err
	}
	return mediaLocalDeleteResult{
		RunID:             runID,
		LocationID:        localLocationID,
		WorkID:            workID,
		Path:              relPath,
		Status:            "succeeded",
		Deleted:           deleted,
		ClearedProgress:   clearedProgress,
		ClearedWorkStates: clearedStates,
	}, nil
}

func (s *Server) finishLocalMediaDelete(ctx context.Context, runID int64, deleteNodeID int64, cleanupNodeID int64, status string, locationID int64, relPath string, deleted bool, clearedProgress int64, clearedStates int64, errorMessage string) error {
	output := mustJSON(map[string]any{"location_id": locationID, "path": relPath, "deleted": deleted, "cleared_progress": clearedProgress, "cleared_work_states": clearedStates, "error": errorMessage})
	if status != "succeeded" {
		if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id IN (?, ?)", status, output, errorMessage, deleteNodeID, cleanupNodeID); err != nil {
			return err
		}
	} else if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", output, cleanupNodeID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, runID)
	return err
}

func (s *Server) finishMediaCacheCleanup(ctx context.Context, runID int64, nodeID int64, status string, cacheLocationID int64, cachePath string, deleted bool, errorMessage string) error {
	output := mustJSON(map[string]any{"cache_location_id": cacheLocationID, "cache_path": cachePath, "deleted": deleted, "error": errorMessage})
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?,
			output_json = ?,
			error_message = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, output, errorMessage, nodeID); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = ?,
			summary_json = ?,
			finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, output, runID)
	return err
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

func (s *Server) downloadToFile(ctx context.Context, sourceURL string, targetPath string) (int64, error) {
	if strings.TrimSpace(sourceURL) == "" {
		return 0, fmt.Errorf("remote media has no download URL")
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := s.waitRemoteDownloadDelay(ctx); err != nil {
			return 0, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
		if err != nil {
			return 0, err
		}
		request.Header.Set("User-Agent", "Kikoto/0.1 Kikoeru-compatible client")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			lastErr = err
			if attempt < 2 {
				if sleepErr := sleepContext(ctx, s.remoteBackoffDuration(ctx, nil, attempt)); sleepErr != nil {
					return 0, sleepErr
				}
				continue
			}
			return 0, err
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			defer response.Body.Close()
			return writeDownloadResponse(response.Body, targetPath)
		}
		statusErr := fmt.Errorf("remote media download returned HTTP %d", response.StatusCode)
		lastErr = statusErr
		retryable := isRetryableRemoteStatus(response.StatusCode)
		backoff := s.remoteBackoffDuration(ctx, response, attempt)
		_ = response.Body.Close()
		if !retryable || attempt >= 2 {
			return 0, statusErr
		}
		if err := sleepContext(ctx, backoff); err != nil {
			return 0, err
		}
	}
	return 0, lastErr
}

func writeDownloadResponse(body io.Reader, targetPath string) (int64, error) {
	tempPath := targetPath + ".tmp"
	file, err := os.Create(tempPath)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(file, body)
	closeErr := file.Close()
	if copyErr != nil {
		_ = os.Remove(tempPath)
		return 0, copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tempPath)
		return 0, closeErr
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return 0, err
	}
	return written, nil
}

func (s *Server) waitRemoteDownloadDelay(ctx context.Context) error {
	base := s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)
	randomRange := s.settingFloatContext(ctx, "remote_request_delay_random_seconds", 1.5)
	if base < 0 {
		base = 0
	}
	if randomRange < 0 {
		randomRange = 0
	}
	delay := time.Duration(base * float64(time.Second))
	if randomRange > 0 {
		delay += time.Duration(rand.Float64() * randomRange * float64(time.Second))
	}
	return sleepContext(ctx, delay)
}

func (s *Server) remoteBackoffDuration(ctx context.Context, response *http.Response, attempt int) time.Duration {
	fallback := s.settingFloatContext(ctx, "remote_rate_limit_backoff_seconds", 30)
	maximum := s.settingFloatContext(ctx, "remote_max_backoff_seconds", 300)
	if fallback < 0 {
		fallback = 0
	}
	if maximum <= 0 {
		maximum = 300
	}
	delay := time.Duration(fallback*float64(time.Second)) * time.Duration(attempt+1)
	if response != nil {
		if retryAfter := retryAfterDuration(response.Header.Get("Retry-After")); retryAfter > 0 {
			delay = retryAfter
		}
	}
	maxDelay := time.Duration(maximum * float64(time.Second))
	if delay > maxDelay {
		delay = maxDelay
	}
	return delay
}

func retryAfterDuration(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 {
		return time.Duration(seconds * float64(time.Second))
	}
	if at, err := http.ParseTime(value); err == nil {
		delay := time.Until(at)
		if delay > 0 {
			return delay
		}
	}
	return 0
}

func isRetryableRemoteStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func cacheMediaRelPath(sourceCode string, workCode string, remotePath string) string {
	cleanSource := sourceCodePattern.ReplaceAllString(strings.ToLower(strings.TrimSpace(sourceCode)), "_")
	cleanSource = strings.Trim(cleanSource, "_")
	if cleanSource == "" {
		cleanSource = "remote"
	}
	workCode = strings.ToUpper(strings.TrimSpace(workCode))
	if workCode == "" {
		workCode = "UNKNOWN"
	}
	parts := strings.Split(strings.ReplaceAll(remotePath, "\\", "/"), "/")
	cleanParts := []string{"voiceworks_" + cleanSource, workCode}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || part == "." || part == ".." {
			continue
		}
		cleanParts = append(cleanParts, filepath.Base(part))
	}
	return filepath.ToSlash(filepath.Join(cleanParts...))
}

func (s *Server) loadWorkDetail(ctx context.Context, userID int64, id int64) (workDetail, error) {
	if err := s.ensureCircleSchema(ctx); err != nil {
		return workDetail{}, err
	}
	var work workDetail
	var releaseDate sql.NullString
	var durationSeconds sql.NullInt64
	var favorite int
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			work.id,
			work.primary_code,
			work.work_type,
			work.title,
			work.title_kana,
			work.description,
			work.release_date,
			work.age_rating,
			work.duration_seconds,
			work.created_at,
			work.updated_at,
			COALESCE(user_work_state.listening_status, 'none') AS listening_status,
			COALESCE(user_work_state.favorite, 0) AS favorite
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id
			AND user_work_state.user_id = ?
		WHERE work.id = ?
	`, userID, id).Scan(
		&work.ID,
		&work.PrimaryCode,
		&work.WorkType,
		&work.Title,
		&work.TitleKana,
		&work.Description,
		&releaseDate,
		&work.AgeRating,
		&durationSeconds,
		&work.CreatedAt,
		&work.UpdatedAt,
		&work.ListeningStatus,
		&favorite,
	); err != nil {
		return workDetail{}, err
	}
	work.Favorite = favorite != 0
	work.ReleaseDate = nullableString(releaseDate)
	work.DurationSeconds = nullableInt64(durationSeconds)
	work.CoverURL = s.coverURL(work.PrimaryCode)
	work.DLsiteURL = dlsiteURL(work.PrimaryCode)
	work.MediaItems = []mediaItemDetail{}

	var snapshot sql.NullString
	var snapshotFetchedAt sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT metadata_snapshot.snapshot_json, metadata_snapshot.fetched_at
		FROM metadata_snapshot
		INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id
		WHERE metadata_snapshot.work_id = ?
			AND metadata_provider.code = 'dlsite'
		ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC
		LIMIT 1
	`, id).Scan(&snapshot, &snapshotFetchedAt); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return workDetail{}, err
	}
	metadata := parseDLsiteSnapshot(snapshot.String)
	if snapshotFetchedAt.Valid {
		work.DLsiteFetchedAt = snapshotFetchedAt.String
	}
	if metadata.DLsiteUpdatedAt != nil {
		work.DLsiteFetchedAt = *metadata.DLsiteUpdatedAt
	}
	work.Circle = metadata.Circle
	work.CircleExternalID = metadata.CircleExternalID
	work.BaseCode = metadata.BaseCode
	work.MetadataLanguage = metadata.MetadataLanguage
	var partyLink sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT party.display_name || '|' || external.external_id
		FROM work_party AS relation
		INNER JOIN party ON party.id = relation.party_id
		LEFT JOIN party_external_id AS external ON external.party_id = party.id
			AND external.is_primary = 1
		WHERE relation.work_id = ?
			AND relation.role = 'circle'
		ORDER BY relation.updated_at DESC
		LIMIT 1
	`, id).Scan(&partyLink); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return workDetail{}, err
	}
	if name, externalID := parsePartyLink(partyLink.String); name != "" {
		work.Circle = name
		work.CircleExternalID = externalID
	}
	work.Rating = metadata.Rating
	work.RatingCount = metadata.RatingCount
	work.Sales = metadata.Sales
	work.Series = metadata.Series
	work.Tags = metadata.Tags
	work.VoiceActors = metadata.VoiceActors
	work.VoiceCredits = []voiceCredit{}
	translations, err := s.loadWorkTranslations(ctx, work.PrimaryCode, work.BaseCode, metadata.LanguageEditions)
	if err != nil {
		return workDetail{}, err
	}
	work.Translations = translations
	creditRows, err := s.db.QueryContext(ctx, `
		SELECT person.id, person.display_name
		FROM work_credit AS credit
		INNER JOIN person ON person.id = credit.person_id
		WHERE credit.work_id = ?
			AND credit.role = 'voice_actor'
		ORDER BY person.display_name ASC, person.id ASC
	`, id)
	if err != nil {
		return workDetail{}, err
	}
	defer creditRows.Close()
	for creditRows.Next() {
		var credit voiceCredit
		if err := creditRows.Scan(&credit.PersonID, &credit.DisplayName); err != nil {
			return workDetail{}, err
		}
		work.VoiceCredits = append(work.VoiceCredits, credit)
	}
	if err := creditRows.Err(); err != nil {
		return workDetail{}, err
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT
			media_item.id,
			media_item.parent_id,
			media_item.kind,
			media_item.title,
			media_item.disc_no,
			media_item.track_no,
			media_item.duration_seconds,
			media_item.size_bytes,
			media_item.fingerprint,
			user_media_progress.position_seconds,
			user_media_progress.duration_seconds,
			user_media_progress.completed,
			user_media_progress.last_played_at
		FROM media_item
		LEFT JOIN user_media_progress ON user_media_progress.media_item_id = media_item.id
			AND user_media_progress.user_id = ?
		WHERE media_item.work_id = ?
		ORDER BY
			COALESCE(media_item.disc_no, 0) ASC,
			COALESCE(media_item.track_no, 0) ASC,
			media_item.title ASC,
			media_item.id ASC
	`, userID, id)
	if err != nil {
		return workDetail{}, err
	}
	defer rows.Close()

	itemIndexes := map[int64]int{}
	for rows.Next() {
		var item mediaItemDetail
		var parentID sql.NullInt64
		var discNo sql.NullInt64
		var trackNo sql.NullInt64
		var itemDurationSeconds sql.NullInt64
		var sizeBytes sql.NullInt64
		var progressPositionSeconds sql.NullFloat64
		var progressDurationSeconds sql.NullFloat64
		var progressCompleted sql.NullBool
		var progressLastPlayedAt sql.NullString
		if err := rows.Scan(
			&item.ID,
			&parentID,
			&item.Kind,
			&item.Title,
			&discNo,
			&trackNo,
			&itemDurationSeconds,
			&sizeBytes,
			&item.Fingerprint,
			&progressPositionSeconds,
			&progressDurationSeconds,
			&progressCompleted,
			&progressLastPlayedAt,
		); err != nil {
			return workDetail{}, err
		}
		item.ParentID = nullableInt64(parentID)
		item.DiscNo = nullableInt64(discNo)
		item.TrackNo = nullableInt64(trackNo)
		item.DurationSeconds = nullableInt64(itemDurationSeconds)
		item.SizeBytes = nullableInt64(sizeBytes)
		item.Progress = nullableMediaProgress(progressPositionSeconds, progressDurationSeconds, progressCompleted, progressLastPlayedAt)
		item.Locations = []fileLocationDetail{}
		itemIndexes[item.ID] = len(work.MediaItems)
		work.MediaItems = append(work.MediaItems, item)
	}
	if err := rows.Err(); err != nil {
		return workDetail{}, err
	}

	if len(work.MediaItems) == 0 {
		return work, nil
	}

	locationRows, err := s.db.QueryContext(ctx, `
		SELECT
			location.id,
			location.media_item_id,
			location.file_source_id,
			source.code,
			source.display_name,
			location.location_type,
			location.path,
			location.stream_url,
			location.download_url,
			location.remote_hash,
			location.size_bytes,
			location.duration_seconds,
			location.availability,
			location.last_checked_at
		FROM media_file_location AS location
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
		ORDER BY source.priority ASC, location.id ASC
	`, id)
	if err != nil {
		return workDetail{}, err
	}
	defer locationRows.Close()

	for locationRows.Next() {
		var mediaItemID int64
		var location fileLocationDetail
		var sizeBytes sql.NullInt64
		var locationDurationSeconds sql.NullInt64
		var lastCheckedAt sql.NullString
		if err := locationRows.Scan(
			&location.ID,
			&mediaItemID,
			&location.FileSourceID,
			&location.FileSourceCode,
			&location.FileSourceName,
			&location.LocationType,
			&location.Path,
			&location.StreamURL,
			&location.DownloadURL,
			&location.RemoteHash,
			&sizeBytes,
			&locationDurationSeconds,
			&location.Availability,
			&lastCheckedAt,
		); err != nil {
			return workDetail{}, err
		}
		location.SizeBytes = nullableInt64(sizeBytes)
		location.DurationSeconds = nullableInt64(locationDurationSeconds)
		location.LastCheckedAt = nullableString(lastCheckedAt)
		if location.LocationType == "local" && location.Availability == "available" && location.StreamURL == "" {
			location.StreamURL = fmt.Sprintf("/api/media/%d/stream", location.ID)
		}
		if index, ok := itemIndexes[mediaItemID]; ok {
			work.MediaItems[index].Locations = append(work.MediaItems[index].Locations, location)
		}
	}
	if err := locationRows.Err(); err != nil {
		return workDetail{}, err
	}

	return work, nil
}

func (s *Server) resolveWorkCodeDetail(ctx context.Context, code string) (workResolveResponse, error) {
	code = normalizeDLsiteCode(code)
	if code == "" {
		return workResolveResponse{}, sql.ErrNoRows
	}

	workID, primaryCode, baseCode, err := s.loadWorkCodeMetadata(ctx, code)
	if err != nil {
		return workResolveResponse{}, err
	}
	resolvedCode := primaryCode
	resolvedID := workID
	if baseCode != "" && !strings.EqualFold(baseCode, primaryCode) {
		if baseID, _, _, err := s.loadWorkCodeMetadata(ctx, baseCode); err == nil {
			resolvedID = baseID
			resolvedCode = baseCode
		}
	}
	return workResolveResponse{
		RequestedCode: code,
		ResolvedCode:  resolvedCode,
		WorkID:        resolvedID,
		BaseCode:      baseCode,
		IsTranslation: !strings.EqualFold(code, resolvedCode),
	}, nil
}

func (s *Server) loadWorkCodeMetadata(ctx context.Context, code string) (int64, string, string, error) {
	var workID int64
	var primaryCode string
	var snapshot sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT work.id, work.primary_code, (
			SELECT metadata_snapshot.snapshot_json
			FROM metadata_snapshot
			INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id
			WHERE metadata_snapshot.work_id = work.id
				AND metadata_provider.code = 'dlsite'
			ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC
			LIMIT 1
		)
		FROM work
		WHERE UPPER(work.primary_code) = UPPER(?)
	`, code).Scan(&workID, &primaryCode, &snapshot); err != nil {
		return 0, "", "", err
	}
	metadata := parseDLsiteSnapshot(snapshot.String)
	return workID, primaryCode, metadata.BaseCode, nil
}

func (s *Server) loadWorkTranslations(ctx context.Context, primaryCode string, baseCode string, editions []workTranslation) ([]workTranslation, error) {
	familyCode := normalizeDLsiteCode(baseCode)
	if familyCode == "" {
		familyCode = normalizeDLsiteCode(primaryCode)
	}
	if familyCode == "" {
		return []workTranslation{}, nil
	}

	translations := []workTranslation{}
	seen := map[string]bool{}
	addTranslation := func(item workTranslation) {
		item.PrimaryCode = normalizeDLsiteCode(item.PrimaryCode)
		if item.PrimaryCode == "" || seen[item.PrimaryCode] {
			return
		}
		seen[item.PrimaryCode] = true
		item.Current = strings.EqualFold(item.PrimaryCode, primaryCode)
		translations = append(translations, item)
	}
	for _, edition := range editions {
		addTranslation(edition)
	}

	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id, work.primary_code, work.title, snapshot.snapshot_json
		FROM work
		LEFT JOIN metadata_snapshot AS snapshot ON snapshot.id = (
			SELECT metadata_snapshot.id
			FROM metadata_snapshot
			INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id
			WHERE metadata_snapshot.work_id = work.id
				AND metadata_provider.code = 'dlsite'
			ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC
			LIMIT 1
		)
		WHERE UPPER(work.primary_code) = UPPER(?)
			OR EXISTS (
				SELECT 1
				FROM metadata_snapshot AS family_snapshot
				INNER JOIN metadata_provider ON metadata_provider.id = family_snapshot.provider_id
				WHERE family_snapshot.work_id = work.id
					AND metadata_provider.code = 'dlsite'
					AND family_snapshot.id = snapshot.id
			)
		ORDER BY work.primary_code ASC
	`, familyCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var workID int64
		var item workTranslation
		var snapshot sql.NullString
		if err := rows.Scan(&workID, &item.PrimaryCode, &item.Title, &snapshot); err != nil {
			return nil, err
		}
		item.WorkID = &workID
		metadata := parseDLsiteSnapshot(snapshot.String)
		if item.MetadataLanguage == "" {
			item.MetadataLanguage = metadata.MetadataLanguage
		}
		translationBaseCode := metadata.BaseCode
		if translationBaseCode == "" {
			translationBaseCode = item.PrimaryCode
		}
		if !strings.EqualFold(translationBaseCode, familyCode) && !strings.EqualFold(item.PrimaryCode, familyCode) {
			continue
		}
		if seen[strings.ToUpper(strings.TrimSpace(item.PrimaryCode))] {
			for index := range translations {
				if strings.EqualFold(translations[index].PrimaryCode, item.PrimaryCode) {
					translations[index].WorkID = item.WorkID
					translations[index].Title = item.Title
					if translations[index].MetadataLanguage == "" {
						translations[index].MetadataLanguage = item.MetadataLanguage
					}
					translations[index].Current = strings.EqualFold(item.PrimaryCode, primaryCode)
					break
				}
			}
			continue
		}
		addTranslation(item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(translations) <= 1 {
		return []workTranslation{}, nil
	}
	return translations, nil
}

func (s *Server) listFileSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	sources, err := s.loadFileSources(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sources)
}

func (s *Server) listWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			run.id,
			run.workflow_code,
			run.display_name,
			run.status,
			run.trigger_type,
			run.trigger_reason,
			run.created_at,
			COALESCE(run.started_at, ''),
			COALESCE(run.finished_at, ''),
			run.summary_json,
			(
				SELECT COUNT(*)
				FROM workflow_node_run
				WHERE workflow_node_run.workflow_run_id = run.id
			) AS node_run_count,
			(
				SELECT COUNT(*)
				FROM workflow_node_run
				WHERE workflow_node_run.workflow_run_id = run.id
					AND workflow_node_run.status = 'succeeded'
			) AS completed_node_runs,
			(
				SELECT COUNT(*)
				FROM workflow_node_run
				WHERE workflow_node_run.workflow_run_id = run.id
					AND workflow_node_run.status = 'failed'
			) AS failed_node_runs,
			(
				SELECT COUNT(*)
				FROM workflow_job
				WHERE workflow_job.workflow_run_id = run.id
			) AS job_count,
			(
				SELECT COUNT(*)
				FROM workflow_job
				WHERE workflow_job.workflow_run_id = run.id
					AND workflow_job.status = 'succeeded'
			) AS completed_jobs,
			(
				SELECT COUNT(*)
				FROM workflow_job
				WHERE workflow_job.workflow_run_id = run.id
					AND workflow_job.status = 'failed'
			) AS failed_jobs,
			(
				SELECT COUNT(*)
				FROM workflow_candidate
				WHERE workflow_candidate.workflow_run_id = run.id
			) AS candidate_count,
			(
				SELECT COUNT(*)
				FROM workflow_candidate
				WHERE workflow_candidate.workflow_run_id = run.id
					AND workflow_candidate.status = 'accepted'
			) AS accepted_candidates,
			(
				SELECT COUNT(*)
				FROM workflow_candidate
				WHERE workflow_candidate.workflow_run_id = run.id
					AND workflow_candidate.status = 'rejected'
			) AS rejected_candidates,
			run.workflow_definition_id,
			run.trigger_id
		FROM workflow_run
			AS run
		ORDER BY run.created_at DESC
		LIMIT 100
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	runs := []workflowRunRecord{}
	for rows.Next() {
		var item workflowRunRecord
		var definitionID sql.NullInt64
		var triggerID sql.NullInt64
		if err := rows.Scan(
			&item.ID,
			&item.WorkflowCode,
			&item.DisplayName,
			&item.Status,
			&item.TriggerType,
			&item.TriggerReason,
			&item.CreatedAt,
			&item.StartedAt,
			&item.FinishedAt,
			&item.SummaryJSON,
			&item.NodeRunCount,
			&item.CompletedNodeRuns,
			&item.FailedNodeRuns,
			&item.JobCount,
			&item.CompletedJobs,
			&item.FailedJobs,
			&item.CandidateCount,
			&item.AcceptedCandidates,
			&item.RejectedCandidates,
			&definitionID,
			&triggerID,
		); err != nil {
			writeError(w, err)
			return
		}
		item.DefinitionID = nullableInt64(definitionID)
		item.TriggerID = nullableInt64(triggerID)
		runs = append(runs, item)
	}

	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) listWorkflowDefinitions(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	if err := s.ensureSystemWorkflowDefinitions(r.Context()); err != nil {
		writeError(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			definition.id,
			definition.code,
			definition.display_name,
			definition.description,
			definition.definition_json,
			definition.scope,
			definition.editable,
			definition.owner_user_id,
			(
				SELECT COUNT(*)
				FROM workflow_trigger
				WHERE workflow_trigger.workflow_definition_id = definition.id
			) AS trigger_count,
			definition.created_at,
			definition.updated_at
		FROM workflow_definition AS definition
		ORDER BY definition.display_name ASC
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	definitions := []workflowDefinitionRecord{}
	for rows.Next() {
		var item workflowDefinitionRecord
		var ownerUserID sql.NullInt64
		if err := rows.Scan(
			&item.ID,
			&item.Code,
			&item.DisplayName,
			&item.Description,
			&item.DefinitionJSON,
			&item.Scope,
			&item.Editable,
			&ownerUserID,
			&item.TriggerCount,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			writeError(w, err)
			return
		}
		item.OwnerUserID = nullableInt64(ownerUserID)
		definitions = append(definitions, item)
	}
	writeJSON(w, http.StatusOK, definitions)
}

func (s *Server) listWorkflowTriggers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			trigger.id,
			trigger.workflow_definition_id,
			definition.code,
			trigger.display_name,
			trigger.trigger_type,
			trigger.enabled,
			trigger.schedule_json,
			trigger.config_json,
			trigger.next_run_at,
			trigger.last_run_at,
			trigger.last_success_at,
			trigger.last_error_message,
			trigger.created_at,
			trigger.updated_at
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		ORDER BY trigger.enabled DESC, trigger.display_name ASC
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	triggers := []workflowTriggerRecord{}
	for rows.Next() {
		var item workflowTriggerRecord
		var nextRunAt sql.NullString
		var lastRunAt sql.NullString
		var lastSuccessAt sql.NullString
		if err := rows.Scan(
			&item.ID,
			&item.WorkflowDefinitionID,
			&item.WorkflowCode,
			&item.DisplayName,
			&item.TriggerType,
			&item.Enabled,
			&item.ScheduleJSON,
			&item.ConfigJSON,
			&nextRunAt,
			&lastRunAt,
			&lastSuccessAt,
			&item.LastErrorMessage,
			&item.CreatedAt,
			&item.UpdatedAt,
		); err != nil {
			writeError(w, err)
			return
		}
		item.NextRunAt = nullableString(nextRunAt)
		item.LastRunAt = nullableString(lastRunAt)
		item.LastSuccessAt = nullableString(lastSuccessAt)
		triggers = append(triggers, item)
	}
	writeJSON(w, http.StatusOK, triggers)
}

func (s *Server) createLocalScanRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	result, err := s.runLocalScan(r.Context(), "manual", "manual")
	if err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) createRemoteBulkRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	var payload struct {
		Action   string   `json:"action"`
		SourceID int64    `json:"sourceId"`
		Codes    []string `json:"codes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	payload.Action = strings.TrimSpace(payload.Action)
	if payload.Action != "sync" && payload.Action != "save" && payload.Action != "sync_save" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be sync, save, or sync_save"})
		return
	}
	codes := []string{}
	seen := map[string]bool{}
	for _, raw := range payload.Codes {
		code := strings.ToUpper(strings.TrimSpace(raw))
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
	}
	if payload.SourceID <= 0 || len(codes) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sourceId and codes are required"})
		return
	}
	result, err := s.runRemoteBulkWorkflow(context.WithoutCancel(r.Context()), payload.SourceID, payload.Action, codes)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type remoteBulkWorkflowResult struct {
	RunID     int64    `json:"runId"`
	SourceID  int64    `json:"sourceId"`
	Action    string   `json:"action"`
	Codes     []string `json:"codes"`
	Status    string   `json:"status"`
	Synced    int      `json:"synced"`
	Fetched   int      `json:"fetched"`
	ChildRuns []int64  `json:"childRuns"`
}

func (s *Server) runRemoteBulkWorkflow(ctx context.Context, sourceID int64, action string, codes []string) (remoteBulkWorkflowResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteBulkWorkflowResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_bulk_action", "Run remote bulk action", "Select multiple remote works and dispatch per-work sync or save workflows.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_works"},
			{"id": "dispatch", "type": "dispatch_child_workflows"},
		},
	})
	if err != nil {
		return remoteBulkWorkflowResult{}, err
	}
	input := map[string]any{"source_id": sourceID, "action": action, "codes": codes}
	summary := map[string]any{"source_id": sourceID, "action": action, "works": len(codes)}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_bulk_action", "Run remote bulk action", "running", "manual", action, input, summary)
	if err != nil {
		return remoteBulkWorkflowResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_works", DisplayName: "Select remote works", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"works": len(codes)},
	}); err != nil {
		return remoteBulkWorkflowResult{}, err
	}
	dispatchNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "dispatch", NodeType: "dispatch_child_workflows", DisplayName: "Dispatch per-work workflows", Position: 2, Status: "running",
		Input: map[string]any{"action": action}, Output: map[string]any{"expected_child_runs": len(codes)},
	})
	if err != nil {
		return remoteBulkWorkflowResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteBulkWorkflowResult{}, err
	}

	result := remoteBulkWorkflowResult{RunID: runID, SourceID: sourceID, Action: action, Codes: codes, Status: "succeeded"}
	for _, code := range codes {
		if action == "sync" || action == "sync_save" {
			syncResult, err := s.runRemoteWorkSync(ctx, sourceID, code, "remote_bulk_"+action)
			if err != nil {
				_ = s.finishRemoteBulkWorkflow(ctx, runID, dispatchNodeID, "failed", result, err)
				return remoteBulkWorkflowResult{}, err
			}
			result.Synced++
			result.ChildRuns = append(result.ChildRuns, syncResult.RunID)
		}
		if action == "save" || action == "sync_save" {
			saveResult, err := s.runRemoteWorkSave(ctx, sourceID, code, []string{})
			if err != nil {
				_ = s.finishRemoteBulkWorkflow(ctx, runID, dispatchNodeID, "failed", result, err)
				return remoteBulkWorkflowResult{}, err
			}
			result.Fetched++
			result.ChildRuns = append(result.ChildRuns, saveResult.RunID)
		}
	}
	if err := s.finishRemoteBulkWorkflow(ctx, runID, dispatchNodeID, "succeeded", result, nil); err != nil {
		return remoteBulkWorkflowResult{}, err
	}
	return result, nil
}

func (s *Server) finishRemoteBulkWorkflow(ctx context.Context, runID int64, dispatchNodeID int64, status string, result remoteBulkWorkflowResult, runErr error) error {
	result.Status = status
	output := map[string]any{
		"action":     result.Action,
		"source_id":  result.SourceID,
		"codes":      result.Codes,
		"synced":     result.Synced,
		"fetched":    result.Fetched,
		"child_runs": result.ChildRuns,
	}
	errorMessage := ""
	if runErr != nil {
		errorMessage = runErr.Error()
		output["error"] = errorMessage
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(output), errorMessage, dispatchNodeID); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, mustJSON(output), runID); err != nil {
		return err
	}
	return nil
}

func (s *Server) RunStartupWorkflows(ctx context.Context) error {
	var enabled int
	err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(MAX(trigger.enabled), 0)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = 'local_library_scan'
			AND trigger.trigger_type = 'startup'
	`).Scan(&enabled)
	if err != nil {
		return err
	}
	if enabled == 0 {
		return nil
	}
	_, err = s.runLocalScan(ctx, "startup", "system_startup")
	return err
}

func (s *Server) createDLsiteSyncRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	language := normalizeDLsiteLanguage(s.settingString(r, "dlsite_metadata_language", "ja-jp"))
	syncer := metasync.NewDLsiteSyncer(s.db, dlsite.NewClient(nil)).
		WithCacheRoot(s.cfg.CacheRoot).
		WithLanguages(dlsiteLanguageFallbacks(language))
	result, err := syncer.SyncAll(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}

func dlsiteLanguageFallbacks(language string) []string {
	language = normalizeDLsiteLanguage(language)
	if language == "" || language == "ja-jp" {
		return []string{"ja-jp", ""}
	}
	return []string{language, "ja-jp", ""}
}

type localScanResult struct {
	RunID            int64  `json:"runId"`
	JobID            int64  `json:"jobId"`
	FileSourceID     int64  `json:"fileSourceId"`
	Status           string `json:"status"`
	DetectedWorks    int    `json:"detectedWorks"`
	ScannedFiles     int    `json:"scannedFiles"`
	UpdatedLocations int    `json:"updatedLocations"`
}

func (s *Server) runLocalScan(ctx context.Context, triggerType string, triggerReason string) (localScanResult, error) {
	scanDepth := s.configuredLocalScanDepth(ctx)

	workFolders, scanSummary, err := localfs.Discover(s.cfg.DataRoot, localfs.Options{ScanDepth: scanDepth})
	if err != nil {
		return localScanResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return localScanResult{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_library_scan", "Scan local library", "Discover local files, match works, and sync local file locations.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_local_source"},
			{"id": "discover", "type": "discover_local_files"},
			{"id": "match", "type": "match_works"},
			{"id": "sync", "type": "sync_file_locations"},
		},
	})
	if err != nil {
		return localScanResult{}, err
	}

	runInput := map[string]any{
		"root":       s.cfg.DataRoot,
		"scan_depth": scanDepth,
	}
	runSummary := map[string]any{
		"candidate_folders": scanSummary.CandidateFolders,
		"detected_works":    scanSummary.DetectedWorks,
		"scanned_files":     scanSummary.ScannedFiles,
		"ambiguous_folders": scanSummary.AmbiguousFolders,
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "local_library_scan", "Scan local library", "succeeded", triggerType, triggerReason, runInput, runSummary)
	if err != nil {
		return localScanResult{}, err
	}

	fileSourceID, err := s.upsertLocalFileSource(ctx, tx, scanDepth)
	if err != nil {
		return localScanResult{}, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'missing',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
			AND location_type = 'local'
	`, fileSourceID); err != nil {
		return localScanResult{}, err
	}

	updatedLocations := 0
	for _, folder := range workFolders {
		workID, err := upsertDetectedWork(ctx, tx, folder)
		if err != nil {
			return localScanResult{}, err
		}

		audioTrackNo := 1
		for _, file := range folder.Files {
			kind := localFileKind(file.WorkRelPath)
			trackNo := 0
			if kind == "audio" {
				trackNo = audioTrackNo
				audioTrackNo++
			}
			mediaItemID, err := upsertDetectedMediaItem(ctx, tx, workID, folder, file, kind, trackNo)
			if err != nil {
				return localScanResult{}, err
			}
			if _, err := upsertDetectedLocation(ctx, tx, mediaItemID, fileSourceID, file); err != nil {
				return localScanResult{}, err
			}
			updatedLocations++
		}
	}

	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "select",
		NodeType:    "select_local_source",
		DisplayName: "Select local source",
		Position:    1,
		Status:      "succeeded",
		Input:       runInput,
		Output: map[string]any{
			"file_source_id": fileSourceID,
			"root":           s.cfg.DataRoot,
		},
	}); err != nil {
		return localScanResult{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "discover",
		NodeType:    "discover_local_files",
		DisplayName: "Discover local files",
		Position:    2,
		Status:      "succeeded",
		Input:       runInput,
		Output: map[string]any{
			"candidate_folders": scanSummary.CandidateFolders,
			"detected_works":    scanSummary.DetectedWorks,
			"scanned_files":     scanSummary.ScannedFiles,
			"ambiguous_folders": scanSummary.AmbiguousFolders,
		},
	})
	if err != nil {
		return localScanResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID:       discoverNodeID,
		WorkerType:      "local_folder_discovery",
		Status:          "succeeded",
		Payload:         runInput,
		ProgressCurrent: scanSummary.ScannedFiles,
		ProgressTotal:   scanSummary.ScannedFiles,
	})
	if err != nil {
		return localScanResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "match",
		NodeType:    "match_works",
		DisplayName: "Match works",
		Position:    3,
		Status:      "succeeded",
		Input: map[string]any{
			"detected_works": scanSummary.DetectedWorks,
		},
		Output: map[string]any{
			"matched_works": scanSummary.DetectedWorks,
		},
	}); err != nil {
		return localScanResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "sync",
		NodeType:    "sync_file_locations",
		DisplayName: "Sync file locations",
		Position:    4,
		Status:      "succeeded",
		Input: map[string]any{
			"file_source_id": fileSourceID,
		},
		Output: map[string]any{
			"updated_locations": updatedLocations,
		},
	}); err != nil {
		return localScanResult{}, err
	}

	if err := tx.Commit(); err != nil {
		return localScanResult{}, err
	}

	return localScanResult{
		RunID:            runID,
		JobID:            jobID,
		FileSourceID:     fileSourceID,
		Status:           "succeeded",
		DetectedWorks:    scanSummary.DetectedWorks,
		ScannedFiles:     scanSummary.ScannedFiles,
		UpdatedLocations: updatedLocations,
	}, nil
}

func (s *Server) configuredLocalScanDepth(ctx context.Context) int {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = 'local_scan_depth'").Scan(&raw); err != nil {
		return s.cfg.LocalScanDepth
	}
	var value int
	if err := json.Unmarshal([]byte(raw), &value); err != nil || value <= 0 {
		return s.cfg.LocalScanDepth
	}
	return value
}

func (s *Server) upsertLocalFileSource(ctx context.Context, tx *sql.Tx, scanDepth int) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES ('main_local_library', 'Main local library', 'local_folder', 1, 1, ?)
		ON CONFLICT(code) DO UPDATE SET
			display_name = excluded.display_name,
			source_type = excluded.source_type,
			priority = excluded.priority,
			enabled = excluded.enabled,
			config_json = excluded.config_json,
			updated_at = CURRENT_TIMESTAMP
	`, mustJSON(map[string]any{
		"root":             s.cfg.DataRoot,
		"scan_depth":       scanDepth,
		"watch_enabled":    false,
		"code_patterns":    []string{"RJ", "BJ", "VJ", "CC"},
		"audio_extensions": []string{".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac"},
	})); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, "SELECT id FROM file_source WHERE code = ?", "main_local_library")
}

func upsertDetectedWork(ctx context.Context, tx *sql.Tx, folder localfs.WorkFolder) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, description)
		VALUES (?, 'audio', ?, ?)
		ON CONFLICT(primary_code) DO UPDATE SET
			description = CASE
				WHEN work.description = '' OR work.description LIKE 'Detected from local folder %' THEN excluded.description
				ELSE work.description
			END,
			updated_at = CURRENT_TIMESTAMP
	`, folder.Code, folder.Title, fmt.Sprintf("Detected from local folder %s.", filepath.ToSlash(folder.RelPath))); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", folder.Code)
}

func upsertDetectedMediaItem(ctx context.Context, tx *sql.Tx, workID int64, folder localfs.WorkFolder, file localfs.LocalFile, kind string, trackNo int) (int64, error) {
	fingerprint := fmt.Sprintf("local:%s:%s", folder.Code, file.WorkRelPath)
	var trackNoValue any
	if trackNo > 0 {
		trackNoValue = trackNo
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO media_item (
			work_id,
			kind,
			title,
			track_no,
			duration_seconds,
			size_bytes,
			fingerprint
		)
		SELECT ?, ?, ?, ?, NULL, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM media_item WHERE fingerprint = ?
		)
	`, workID, kind, file.Title, trackNoValue, file.SizeBytes, fingerprint, fingerprint); err != nil {
		return 0, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET kind = ?,
			title = ?,
			track_no = ?,
			size_bytes = ?
		WHERE fingerprint = ?
	`, kind, file.Title, trackNoValue, file.SizeBytes, fingerprint); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, "SELECT id FROM media_item WHERE fingerprint = ?", fingerprint)
}

func upsertDetectedLocation(ctx context.Context, tx *sql.Tx, mediaItemID int64, fileSourceID int64, file localfs.LocalFile) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO media_file_location (
			media_item_id,
			file_source_id,
			location_type,
			path,
			size_bytes,
			duration_seconds,
			availability,
			last_checked_at
		)
		SELECT ?, ?, 'local', ?, ?, NULL, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'local'
				AND path = ?
		)
	`, mediaItemID, fileSourceID, file.RelPath, file.SizeBytes, mediaItemID, fileSourceID, file.RelPath); err != nil {
		return 0, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, file.SizeBytes, mediaItemID, fileSourceID, file.RelPath); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, `
		SELECT id
		FROM media_file_location
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, mediaItemID, fileSourceID, file.RelPath)
}

func localFileKind(path string) string {
	extension := strings.ToLower(filepath.Ext(path))
	switch extension {
	case ".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac":
		return "audio"
	case ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif":
		return "image"
	case ".txt", ".md", ".json", ".lrc", ".cue", ".srt", ".ass", ".csv", ".log", ".ini", ".yaml", ".yml":
		return "text"
	default:
		return "file"
	}
}

func isTextFile(path string) bool {
	return localFileKind(path) == "text"
}

func insertAndID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}

	return id, nil
}

func selectID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	var id int64
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, sql.ErrNoRows
		}
		return 0, err
	}

	return id, nil
}

func parseInt64PathValue(r *http.Request, name string) (int64, error) {
	value := r.PathValue(name)
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid path value %s", name)
	}
	return id, nil
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

type dlsiteSnapshotMetadata struct {
	Circle           string
	CircleExternalID string
	BaseCode         string
	MetadataLanguage string
	LanguageEditions []workTranslation
	ReleaseDate      *string
	Rating           *float64
	RatingCount      *int64
	Sales            *int64
	Series           string
	DLsiteUpdatedAt  *string
	Tags             []string
	VoiceActors      []string
}

func parseDLsiteSnapshot(raw string) dlsiteSnapshotMetadata {
	metadata := dlsiteSnapshotMetadata{
		Tags:        []string{},
		VoiceActors: []string{},
	}
	if strings.TrimSpace(raw) == "" {
		return metadata
	}

	rawBytes := []byte(raw)
	var combined struct {
		Product json.RawMessage `json:"product"`
		Dynamic json.RawMessage `json:"dynamic"`
		Kikoto  struct {
			Language string `json:"language"`
		} `json:"_kikoto"`
	}
	if err := json.Unmarshal(rawBytes, &combined); err == nil && len(combined.Product) > 0 {
		rawBytes = combined.Product
	}

	var payload struct {
		MakerName          string   `json:"maker_name"`
		MakerID            string   `json:"maker_id"`
		CircleID           string   `json:"circle_id"`
		BrandID            string   `json:"brand_id"`
		LabelID            string   `json:"label_id"`
		WorkNo             string   `json:"workno"`
		ProductID          string   `json:"product_id"`
		OriginalWorkNo     string   `json:"original_workno"`
		OriginalWorkNumber string   `json:"original_work_number"`
		BaseWorkNo         string   `json:"base_workno"`
		BaseCode           string   `json:"base_code"`
		Language           string   `json:"language"`
		Locale             string   `json:"locale"`
		ReleaseDate        string   `json:"release_date"`
		UpdateDate         string   `json:"update_date"`
		ModifyDate         string   `json:"modify_date"`
		Sales              *int64   `json:"dl_count"`
		DLCount            *int64   `json:"download_count"`
		SalesCount         *int64   `json:"sales_count"`
		RateAverage2DP     *float64 `json:"rate_average_2dp"`
		RateAverage        *float64 `json:"rate_average"`
		RateCount          *int64   `json:"rate_count"`
		ReviewCount        *int64   `json:"review_count"`
		SeriesName         string   `json:"series_name"`
		Series             string   `json:"series"`
		Genres             []struct {
			Name     string `json:"name"`
			NameBase string `json:"name_base"`
		} `json:"genres"`
		SeriesWork []struct {
			Title string `json:"title"`
			Name  string `json:"name"`
		} `json:"series_work"`
		Creators map[string][]struct {
			Name string `json:"name"`
		} `json:"creaters"`
		Kikoto struct {
			Language string `json:"language"`
		} `json:"_kikoto"`
		TranslationInfo struct {
			OriginalWorkNo string `json:"original_workno"`
			ParentWorkNo   string `json:"parent_workno"`
			Lang           string `json:"lang"`
		} `json:"translation_info"`
		LanguageEditions []struct {
			WorkNo string `json:"workno"`
			Label  string `json:"label"`
			Lang   string `json:"lang"`
		} `json:"language_editions"`
	}
	if err := json.Unmarshal(rawBytes, &payload); err != nil {
		return metadata
	}
	if len(combined.Dynamic) > 0 {
		var dynamic struct {
			RateAverage2DP *float64 `json:"rate_average_2dp"`
			RateAverage    *float64 `json:"rate_average"`
			RateCount      *int64   `json:"rate_count"`
			ReviewCount    *int64   `json:"review_count"`
			Sales          *int64   `json:"dl_count"`
			DLCount        *int64   `json:"download_count"`
			SalesCount     *int64   `json:"sales_count"`
		}
		if err := json.Unmarshal(combined.Dynamic, &dynamic); err == nil {
			if dynamic.RateAverage2DP != nil {
				payload.RateAverage2DP = dynamic.RateAverage2DP
			} else if dynamic.RateAverage != nil {
				payload.RateAverage = dynamic.RateAverage
			}
			if dynamic.RateCount != nil {
				payload.RateCount = dynamic.RateCount
			} else if dynamic.ReviewCount != nil {
				payload.ReviewCount = dynamic.ReviewCount
			}
			if dynamic.Sales != nil {
				payload.Sales = dynamic.Sales
			} else if dynamic.DLCount != nil {
				payload.DLCount = dynamic.DLCount
			} else if dynamic.SalesCount != nil {
				payload.SalesCount = dynamic.SalesCount
			}
		}
	}

	metadata.Circle = strings.TrimSpace(payload.MakerName)
	metadata.CircleExternalID = strings.ToUpper(strings.TrimSpace(firstNonEmpty(payload.CircleID, payload.MakerID, payload.BrandID, payload.LabelID)))
	metadata.MetadataLanguage = strings.TrimSpace(firstNonEmpty(combined.Kikoto.Language, payload.Kikoto.Language, payload.Language, payload.Locale, payload.TranslationInfo.Lang))
	metadata.BaseCode = normalizeDLsiteCode(firstNonEmpty(payload.TranslationInfo.OriginalWorkNo, payload.TranslationInfo.ParentWorkNo, payload.OriginalWorkNo, payload.OriginalWorkNumber, payload.BaseWorkNo, payload.BaseCode))
	currentCode := normalizeDLsiteCode(firstNonEmpty(payload.WorkNo, payload.ProductID))
	if metadata.BaseCode == currentCode {
		metadata.BaseCode = ""
	}
	for _, edition := range payload.LanguageEditions {
		code := normalizeDLsiteCode(edition.WorkNo)
		if code == "" {
			continue
		}
		metadata.LanguageEditions = append(metadata.LanguageEditions, workTranslation{
			PrimaryCode:      code,
			MetadataLanguage: firstNonEmpty(edition.Label, edition.Lang),
			Current:          strings.EqualFold(code, currentCode),
		})
	}
	if release := strings.TrimSpace(payload.ReleaseDate); release != "" {
		metadata.ReleaseDate = &release
	}
	if updated := strings.TrimSpace(firstNonEmpty(payload.UpdateDate, payload.ModifyDate)); updated != "" {
		metadata.DLsiteUpdatedAt = &updated
	}
	if payload.RateAverage2DP != nil {
		metadata.Rating = payload.RateAverage2DP
	} else if payload.RateAverage != nil {
		metadata.Rating = payload.RateAverage
	}
	if payload.RateCount != nil {
		metadata.RatingCount = payload.RateCount
	} else if payload.ReviewCount != nil {
		metadata.RatingCount = payload.ReviewCount
	}
	if payload.Sales != nil {
		metadata.Sales = payload.Sales
	} else if payload.DLCount != nil {
		metadata.Sales = payload.DLCount
	} else if payload.SalesCount != nil {
		metadata.Sales = payload.SalesCount
	}
	metadata.Series = strings.TrimSpace(firstNonEmpty(payload.SeriesName, payload.Series))
	if metadata.Series == "" {
		for _, item := range payload.SeriesWork {
			if name := strings.TrimSpace(firstNonEmpty(item.Title, item.Name)); name != "" {
				metadata.Series = name
				break
			}
		}
	}

	seenTags := map[string]bool{}
	for _, genre := range payload.Genres {
		name := strings.TrimSpace(genre.Name)
		if name == "" {
			name = strings.TrimSpace(genre.NameBase)
		}
		if name == "" || seenTags[name] {
			continue
		}
		seenTags[name] = true
		metadata.Tags = append(metadata.Tags, name)
		if len(metadata.Tags) >= 8 {
			break
		}
	}

	seenActors := map[string]bool{}
	for _, creator := range payload.Creators["voice_by"] {
		name := strings.TrimSpace(creator.Name)
		if name == "" || seenActors[name] {
			continue
		}
		seenActors[name] = true
		metadata.VoiceActors = append(metadata.VoiceActors, name)
	}

	return metadata
}

func parsePartyLink(value string) (string, string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ""
	}
	parts := strings.SplitN(value, "|", 2)
	name := strings.TrimSpace(parts[0])
	externalID := ""
	if len(parts) > 1 {
		externalID = strings.ToUpper(strings.TrimSpace(parts[1]))
	}
	return name, externalID
}

func normalizeDLsiteCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) >= 7 && len(value) <= 10 && (strings.HasPrefix(value, "RJ") || strings.HasPrefix(value, "BJ") || strings.HasPrefix(value, "VJ")) {
		for _, char := range value[2:] {
			if char < '0' || char > '9' {
				return ""
			}
		}
		return value
	}
	return ""
}

func availabilityBadges(rawTypes string) []string {
	if strings.TrimSpace(rawTypes) == "" {
		return []string{"missing"}
	}
	seen := map[string]bool{}
	badges := []string{}
	for _, item := range strings.Split(rawTypes, ",") {
		switch strings.TrimSpace(item) {
		case "local":
			if !seen["local"] {
				seen["local"] = true
				badges = append(badges, "local")
			}
		case "cache":
			if !seen["cache"] {
				seen["cache"] = true
				badges = append(badges, "cache")
			}
		case "remote_stream", "remote_download":
			if !seen["remote"] {
				seen["remote"] = true
				badges = append(badges, "remote")
			}
		}
	}
	if len(badges) == 0 {
		return []string{"missing"}
	}
	return badges
}

func (s *Server) coverURL(primaryCode string) string {
	code := strings.ToUpper(strings.TrimSpace(primaryCode))
	if code == "" {
		return ""
	}
	for _, extension := range []string{".jpg", ".jpeg", ".png", ".webp"} {
		file := code + extension
		path := filepath.Join(s.cfg.CacheRoot, "cover", file)
		if _, err := os.Stat(path); err == nil {
			return "/api/assets/covers/" + file
		}
	}
	return ""
}

func dlsiteURL(primaryCode string) string {
	code := strings.ToUpper(strings.TrimSpace(primaryCode))
	if code == "" {
		return ""
	}
	site := "maniax"
	if strings.HasPrefix(code, "VJ") {
		site = "pro"
	}
	return fmt.Sprintf("https://www.dlsite.com/%s/work/=/product_id/%s.html", site, code)
}

func safeDataPath(root string, relPath string) (string, error) {
	if strings.TrimSpace(relPath) == "" || filepath.IsAbs(relPath) {
		return "", fmt.Errorf("invalid relative path")
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil {
		return "", err
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", fmt.Errorf("path escapes data root")
	}
	return absPath, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func mustJSON(value any) string {
	bytes, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(bytes)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
