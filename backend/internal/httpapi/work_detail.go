package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

type workDetail struct {
	ID               int64                      `json:"id"`
	PrimaryCode      string                     `json:"primaryCode"`
	BaseCode         string                     `json:"baseCode"`
	MetadataLanguage string                     `json:"metadataLanguage"`
	WorkType         string                     `json:"workType"`
	Title            string                     `json:"title"`
	TitleKana        string                     `json:"titleKana"`
	Description      string                     `json:"description"`
	ReleaseDate      *string                    `json:"releaseDate"`
	AgeRating        string                     `json:"ageRating"`
	DurationSeconds  *int64                     `json:"durationSeconds"`
	CreatedAt        string                     `json:"createdAt"`
	UpdatedAt        string                     `json:"updatedAt"`
	CoverURL         string                     `json:"coverUrl"`
	DLsiteURL        string                     `json:"dlsiteUrl"`
	Circle           string                     `json:"circle"`
	CircleExternalID string                     `json:"circleExternalId"`
	Rating           *float64                   `json:"rating"`
	RatingCount      *int64                     `json:"ratingCount"`
	Sales            *int64                     `json:"sales"`
	RegularPrice     *int64                     `json:"regularPrice"`
	Price            *int64                     `json:"price"`
	PriceCurrency    string                     `json:"priceCurrency"`
	PermanentlyFree  *bool                      `json:"permanentlyFree"`
	Series           string                     `json:"series"`
	SeriesTitleID    string                     `json:"seriesTitleId"`
	SeriesCircleID   string                     `json:"seriesCircleExternalId"`
	DLsiteFetchedAt  string                     `json:"dlsiteFetchedAt"`
	Tags             []string                   `json:"tags"`
	UserTags         []workUserTag              `json:"userTags"`
	VoiceActors      []string                   `json:"voiceActors"`
	VoiceCredits     []voiceCredit              `json:"voiceCredits"`
	ListeningStatus  string                     `json:"listeningStatus"`
	Favorite         bool                       `json:"favorite"`
	MetadataView     workMetadataPresentation   `json:"metadataPresentation"`
	MetadataSync     workMetadataSyncStatus     `json:"metadataSync"`
	Translations     []workTranslation          `json:"translations"`
	ManualOverrides  workManualOverrides        `json:"manualOverrides"`
	SourcePresence   []sourcePresenceItem       `json:"sourcePresence"`
	LocalFolders     []workFolderLocationDetail `json:"localFolders"`
	MediaItems       []mediaItemDetail          `json:"mediaItems"`
}

type workMetadataPresentation struct {
	DefaultVariantKey string                `json:"defaultVariantKey"`
	Variants          []workMetadataVariant `json:"variants"`
}

type workMetadataVariant struct {
	Key      string   `json:"key"`
	Language string   `json:"language"`
	Title    string   `json:"title"`
	Tags     []string `json:"tags"`
	Origin   bool     `json:"origin"`
}

type workFolderLocationDetail struct {
	ID           int64  `json:"id"`
	WorkID       int64  `json:"workId"`
	FileSourceID int64  `json:"fileSourceId"`
	RootPath     string `json:"rootPath"`
	Role         string `json:"role"`
	State        string `json:"state"`
	Primary      bool   `json:"primary"`
}

type workTranslation struct {
	WorkID           *int64 `json:"workId"`
	PrimaryCode      string `json:"primaryCode"`
	Title            string `json:"title"`
	MetadataLanguage string `json:"metadataLanguage"`
	EditionLabel     string `json:"editionLabel"`
	Origin           bool   `json:"origin"`
	Official         bool   `json:"official"`
	TranslationKind  string `json:"translationKind"`
	Current          bool   `json:"current"`
	HasMedia         bool   `json:"hasMedia"`
	MediaState       string `json:"mediaState"`
	LocalAvailable   bool   `json:"localAvailable"`
}

const (
	workMediaStateMetadataOnly     = "metadata_only"
	workMediaStatePresentUnindexed = "present_unindexed"
	workMediaStateIndexedAvailable = "indexed_available"
	workMediaStateUnavailable      = "unavailable"
)

type workResolveResponse struct {
	RequestedCode    string   `json:"requestedCode"`
	ResolvedCode     string   `json:"resolvedCode"`
	WorkID           int64    `json:"workId"`
	BaseCode         string   `json:"baseCode"`
	IsTranslation    bool     `json:"isTranslation"`
	Title            string   `json:"title"`
	CoverURL         string   `json:"coverUrl"`
	Circle           string   `json:"circle"`
	CircleExternalID string   `json:"circleExternalId"`
	ReleaseDate      *string  `json:"releaseDate"`
	Rating           *float64 `json:"rating"`
	Sales            *int64   `json:"sales"`
	RegularPrice     *int64   `json:"regularPrice"`
	Price            *int64   `json:"price"`
	PriceCurrency    string   `json:"priceCurrency"`
	PermanentlyFree  *bool    `json:"permanentlyFree"`
	Tags             []string `json:"tags"`
	VoiceActors      []string `json:"voiceActors"`
}

type voiceCredit struct {
	PersonID    int64  `json:"personId"`
	DisplayName string `json:"displayName"`
}

type mediaItemDetail struct {
	ID                         int64                `json:"id"`
	ParentID                   *int64               `json:"parentId"`
	Kind                       string               `json:"kind"`
	Title                      string               `json:"title"`
	DiscNo                     *int64               `json:"discNo"`
	TrackNo                    *int64               `json:"trackNo"`
	DurationSeconds            *int64               `json:"durationSeconds"`
	HasAudio                   *bool                `json:"hasAudio"`
	SizeBytes                  *int64               `json:"sizeBytes"`
	Fingerprint                string               `json:"fingerprint"`
	Progress                   *mediaProgressDetail `json:"progress"`
	PreferredLyricsMediaItemID *int64               `json:"preferredLyricsMediaItemId"`
	Locations                  []fileLocationDetail `json:"locations"`
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
	userID := optionalUserID(r.Context())
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.requireDemoWork(w, r, id) {
		return
	}

	includeMedia := r.URL.Query().Get("includeMedia") != "false"
	if includeMedia {
		if _, err := s.ensureLocalMediaIndexedForRequest(r.Context(), id); err != nil {
			writeError(w, err)
			return
		}
	}

	work, err := s.loadWorkDetail(r.Context(), userID, id, includeMedia)
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

func (s *Server) getWorkMedia(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.requireDemoWork(w, r, id) {
		return
	}
	if _, err := s.ensureLocalMediaIndexedForRequest(r.Context(), id); err != nil {
		writeError(w, err)
		return
	}
	mediaWorkID, err := s.resolveMediaWorkIDForRequest(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	mediaItems, err := s.loadWorkMediaItems(r.Context(), userID, mediaWorkID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workId": id, "mediaWorkId": mediaWorkID, "mediaItems": mediaItems})
}

func (s *Server) loadWorkDetail(ctx context.Context, userID int64, id int64, includeMedia bool) (workDetail, error) {
	var work workDetail
	work, err := s.loadWorkDetailBase(ctx, userID, id)
	if err != nil {
		return workDetail{}, err
	}
	mediaWorkID, err := s.populateWorkDetailMetadata(ctx, &work)
	if err != nil {
		return workDetail{}, err
	}
	work.VoiceCredits, err = s.loadWorkDetailVoiceCredits(ctx, id)
	if err != nil {
		return workDetail{}, err
	}
	if err := s.applyManualOverridesToDetail(ctx, &work); err != nil {
		return workDetail{}, err
	}
	if !includeMedia {
		return work, nil
	}
	work.MediaItems, err = s.loadWorkMediaItems(ctx, userID, mediaWorkID)
	if err != nil {
		return workDetail{}, err
	}
	return work, nil
}

func (s *Server) loadWorkDetailBase(ctx context.Context, userID int64, id int64) (workDetail, error) {
	var work workDetail
	var releaseDate sql.NullString
	var durationSeconds sql.NullInt64
	var rating sql.NullFloat64
	var sales, regularPrice, currentPrice sql.NullInt64
	var permanentlyFree sql.NullBool
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
			work.rating_average,
			work.sales_count,
			work.regular_price,
			work.current_price,
			work.price_currency,
			work.is_permanently_free,
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
		&rating,
		&sales,
		&regularPrice,
		&currentPrice,
		&work.PriceCurrency,
		&permanentlyFree,
		&durationSeconds,
		&work.CreatedAt,
		&work.UpdatedAt,
		&work.ListeningStatus,
		&favorite,
	); err != nil {
		return workDetail{}, err
	}
	work.Favorite = favorite != 0
	work.ReleaseDate = sqlutil.String(releaseDate)
	work.DurationSeconds = sqlutil.Int64(durationSeconds)
	work.Rating = sqlutil.Float64(rating)
	work.Sales = sqlutil.Int64(sales)
	work.RegularPrice = sqlutil.Int64(regularPrice)
	work.Price = sqlutil.Int64(currentPrice)
	if permanentlyFree.Valid {
		work.PermanentlyFree = &permanentlyFree.Bool
	}
	coverURL, err := s.workCoverURL(ctx, work.ID, work.PrimaryCode)
	if err != nil {
		return workDetail{}, err
	}
	work.CoverURL = coverURL
	work.DLsiteURL = s.dlsiteURL(work.PrimaryCode)
	work.SourcePresence = s.sourcePresenceForCode(ctx, work.PrimaryCode)
	localFolders, err := s.loadWorkFolderLocations(ctx, work.ID)
	if err != nil {
		return workDetail{}, err
	}
	work.LocalFolders = localFolders
	work.MediaItems = []mediaItemDetail{}
	userTags, err := s.loadWorkUserTags(ctx, userID, id)
	if err != nil {
		return workDetail{}, err
	}
	work.UserTags = userTags
	return work, nil
}

func (s *Server) populateWorkDetailMetadata(ctx context.Context, work *workDetail) (int64, error) {
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
	`, work.ID).Scan(&snapshot, &snapshotFetchedAt); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
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
	if canonicalCode, metadataLanguage, err := s.loadWorkEditionMetadata(ctx, work.ID); err != nil {
		return 0, err
	} else {
		if canonicalCode != "" && !strings.EqualFold(canonicalCode, work.PrimaryCode) {
			work.BaseCode = canonicalCode
		}
		if metadataLanguage != "" {
			work.MetadataLanguage = metadataLanguage
		}
	}
	var partyLink sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT display_name || '|' || external_id
		FROM work_primary_circle
		WHERE work_id = ?
	`, work.ID).Scan(&partyLink); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if name, externalID := parsePartyLink(partyLink.String); name != "" {
		work.Circle = name
		work.CircleExternalID = externalID
	}
	work.RatingCount = metadata.RatingCount
	work.Series = metadata.Series
	work.SeriesTitleID = s.seriesTitleIDForWork(ctx, work.PrimaryCode)
	work.SeriesCircleID = work.CircleExternalID
	if tags, projected, err := s.loadProjectedDLsiteTags(ctx, work.ID); err != nil {
		return 0, err
	} else if projected || tags != nil {
		work.Tags = tags
	} else {
		work.Tags = metadata.Tags
	}
	if selected, ok, err := metasync.SelectDLsiteMetadataVariant(ctx, s.db, work.ID, s.preferredMetadataLanguages(ctx)); err != nil {
		return 0, err
	} else if ok {
		if selected.IsCanonical {
			work.MetadataLanguage = dlsite.OriginMetadataLanguage
		} else if token := dlsite.EditionMetadataLanguage(selected.EditionLanguage); token != "" {
			work.MetadataLanguage = token
		} else if strings.TrimSpace(selected.EditionLanguage) != "" {
			work.MetadataLanguage = selected.EditionLanguage
		}
	}
	metadataView, err := s.loadWorkMetadataPresentation(ctx, work.ID)
	if err != nil {
		return 0, err
	}
	work.MetadataView = metadataView
	work.MetadataSync, err = s.loadWorkMetadataSyncStatus(ctx, work.ID, metadataView, snapshotFetchedAt)
	if err != nil {
		return 0, err
	}
	work.VoiceActors = metadata.VoiceActors
	translations, err := s.loadWorkTranslations(ctx, work.PrimaryCode, work.BaseCode, metadata.LanguageEditions)
	if err != nil {
		return 0, err
	}
	work.Translations = translations
	mediaWorkID, err := s.resolveMediaWorkID(ctx, work.ID, work.Translations)
	if err != nil {
		return 0, err
	}
	return mediaWorkID, nil
}

func (s *Server) loadWorkDetailVoiceCredits(ctx context.Context, workID int64) ([]voiceCredit, error) {
	creditRows, err := s.db.QueryContext(ctx, `
		SELECT person.id, person.display_name
		FROM work_credit AS credit
		INNER JOIN person ON person.id = credit.person_id
		WHERE credit.work_id = ?
			AND credit.role = 'voice_actor'
		ORDER BY person.display_name ASC, person.id ASC
	`, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = creditRows.Close() }()
	credits := []voiceCredit{}
	for creditRows.Next() {
		var credit voiceCredit
		if err := creditRows.Scan(&credit.PersonID, &credit.DisplayName); err != nil {
			return nil, err
		}
		credits = append(credits, credit)
	}
	if err := creditRows.Err(); err != nil {
		return nil, err
	}
	return credits, nil
}

func (s *Server) loadWorkFolderLocations(ctx context.Context, workID int64) ([]workFolderLocationDetail, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, work_id, file_source_id, root_path, role, state, is_primary
		FROM work_folder_location
		WHERE work_id = ?
		ORDER BY is_primary DESC, updated_at DESC, id ASC
	`, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	folders := []workFolderLocationDetail{}
	for rows.Next() {
		var folder workFolderLocationDetail
		var primary int
		if err := rows.Scan(&folder.ID, &folder.WorkID, &folder.FileSourceID, &folder.RootPath, &folder.Role, &folder.State, &primary); err != nil {
			return nil, err
		}
		folder.RootPath = filepath.ToSlash(strings.Trim(folder.RootPath, "/"))
		folder.Primary = primary != 0
		folders = append(folders, folder)
	}
	return folders, rows.Err()
}

func (s *Server) resolveWorkCodeDetail(ctx context.Context, code string) (workResolveResponse, error) {
	code = normalizeDLsiteCode(code)
	if code == "" {
		return workResolveResponse{}, sql.ErrNoRows
	}

	workID, primaryCode, metadata, err := s.loadWorkCodeMetadata(ctx, code)
	if err != nil {
		return workResolveResponse{}, err
	}
	if err := s.syncWorkEditionForWorkFromSnapshot(ctx, workID, primaryCode, metadata); err != nil {
		return workResolveResponse{}, err
	}
	baseCode := metadata.BaseCode
	resolvedCode := primaryCode
	resolvedID := workID
	if canonicalID, canonicalCode, err := s.loadCanonicalWorkForCode(ctx, primaryCode); err != nil {
		return workResolveResponse{}, err
	} else if canonicalID > 0 && canonicalCode != "" {
		resolvedID = canonicalID
		resolvedCode = canonicalCode
		baseCode = canonicalCode
	}
	var title, priceCurrency string
	var releaseDate sql.NullString
	var rating sql.NullFloat64
	var sales, regularPrice, currentPrice sql.NullInt64
	var permanentlyFree sql.NullBool
	if err := s.db.QueryRowContext(ctx, `
		SELECT title, release_date, rating_average, sales_count, regular_price, current_price, price_currency, is_permanently_free
		FROM work
		WHERE id = ?
	`, resolvedID).Scan(&title, &releaseDate, &rating, &sales, &regularPrice, &currentPrice, &priceCurrency, &permanentlyFree); err != nil {
		return workResolveResponse{}, err
	}
	var permanentlyFreeValue *bool
	if permanentlyFree.Valid {
		permanentlyFreeValue = &permanentlyFree.Bool
	}
	projectedTags, projected, err := s.loadProjectedDLsiteTags(ctx, resolvedID)
	if err != nil {
		return workResolveResponse{}, err
	}
	if !projected {
		projectedTags = metadata.Tags
	}
	return workResolveResponse{
		RequestedCode:    code,
		ResolvedCode:     resolvedCode,
		WorkID:           resolvedID,
		BaseCode:         baseCode,
		IsTranslation:    !strings.EqualFold(code, resolvedCode),
		Title:            title,
		CoverURL:         s.coverURL(resolvedCode),
		Circle:           metadata.Circle,
		CircleExternalID: metadata.CircleExternalID,
		ReleaseDate:      sqlutil.String(releaseDate),
		Rating:           sqlutil.Float64(rating),
		Sales:            sqlutil.Int64(sales),
		RegularPrice:     sqlutil.Int64(regularPrice),
		Price:            sqlutil.Int64(currentPrice),
		PriceCurrency:    priceCurrency,
		PermanentlyFree:  permanentlyFreeValue,
		Tags:             projectedTags,
		VoiceActors:      metadata.VoiceActors,
	}, nil
}

func (s *Server) loadWorkCodeMetadata(ctx context.Context, code string) (int64, string, dlsiteSnapshotMetadata, error) {
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
		return 0, "", dlsiteSnapshotMetadata{}, err
	}
	metadata := parseDLsiteSnapshot(snapshot.String)
	return workID, primaryCode, metadata, nil
}

func normalizedWorkMediaState(workID *int64, hasMedia bool, hasLocalPresence bool, current string) string {
	if current != "" {
		return current
	}
	if workID == nil {
		return workMediaStateMetadataOnly
	}
	if hasMedia {
		return workMediaStateIndexedAvailable
	}
	if hasLocalPresence {
		return workMediaStatePresentUnindexed
	}
	return workMediaStateUnavailable
}
