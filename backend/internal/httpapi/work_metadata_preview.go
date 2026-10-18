package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
)

// workMetadataPreviewValues is the safe, normalized subset shown by the
// editor. It deliberately omits provider URLs and raw upstream payloads.
type workMetadataPreviewValues struct {
	Title            string                             `json:"title"`
	TitleLanguage    string                             `json:"titleLanguage"`
	Description      string                             `json:"description"`
	ReleaseDate      *string                            `json:"releaseDate"`
	AgeRating        string                             `json:"ageRating"`
	Series           string                             `json:"series"`
	Rating           *float64                           `json:"rating"`
	Sales            *int64                             `json:"sales"`
	RegularPrice     *int64                             `json:"regularPrice"`
	Price            *int64                             `json:"price"`
	PriceCurrency    string                             `json:"priceCurrency"`
	PermanentlyFree  *bool                              `json:"permanentlyFree"`
	Circle           string                             `json:"circle"`
	CircleExternalID string                             `json:"circleExternalId"`
	Tags             []string                           `json:"tags"`
	TagItems         []workMetadataPreviewTag           `json:"tagItems"`
	VoiceActors      []string                           `json:"voiceActors"`
	CoverAvailable   bool                               `json:"coverAvailable"`
	Family           []workMetadataPreviewFamilyEdition `json:"family"`
}

type workMetadataPreviewTag struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type workMetadataPreviewFamilyEdition struct {
	Code      string `json:"code"`
	Language  string `json:"language"`
	Label     string `json:"label"`
	Origin    bool   `json:"origin"`
	Available bool   `json:"available"`
}

type workMetadataPreviewResponse struct {
	PreviewID     string                    `json:"previewId"`
	WorkID        int64                     `json:"workId"`
	PrimaryCode   string                    `json:"primaryCode"`
	Provider      string                    `json:"provider"`
	SourceCode    string                    `json:"sourceCode"`
	SourceName    string                    `json:"sourceName"`
	BaseUpdatedAt string                    `json:"baseUpdatedAt"`
	Current       workMetadataPreviewValues `json:"current"`
	Fetched       workMetadataPreviewValues `json:"fetched"`
}

const (
	metadataPreviewTTL   = 15 * time.Minute
	metadataPreviewLimit = 32
)

type metadataPreviewRecord struct {
	ID            string
	WorkID        int64
	UserID        int64
	PrimaryCode   string
	BaseUpdatedAt string
	SourceID      int64
	Product       *dlsite.Product
	RemoteRaw     []byte
	CreatedAt     time.Time
}

type workMetadataPreviewOptions struct {
	SourceID *int64 `json:"sourceId"`
}

type workMetadataPreviewApplyRequest struct {
	PreviewID     string                    `json:"previewId"`
	SourceID      *int64                    `json:"sourceId"`
	BaseUpdatedAt string                    `json:"baseUpdatedAt"`
	Selections    map[string]string         `json:"selections"`
	Values        workMetadataPreviewValues `json:"values"`
	CurrentTags   []workMetadataPreviewTag  `json:"currentTags"`
	FetchedTags   []workMetadataPreviewTag  `json:"fetchedTags"`
}

// createWorkMetadataPreview fetches one existing work without changing any
// snapshot, projection, work, or workflow state. The editor uses this as a
// short-lived comparison source before deciding what to save.
func (s *Server) createWorkMetadataPreview(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.workIDExists(r.Context(), workID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	if s.refuseCustomWork(w, r, workID) {
		return
	}
	var options workMetadataPreviewOptions
	if r.Body != nil {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&options); err != nil && !errors.Is(err, io.EOF) {
			writeAPIError(w, http.StatusBadRequest, "invalid_metadata_preview", "invalid metadata preview options", false)
			return
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			writeAPIError(w, http.StatusBadRequest, "invalid_metadata_preview", "invalid metadata preview options", false)
			return
		}
	}
	if options.SourceID != nil && *options.SourceID <= 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_metadata_source", "invalid metadata source", false)
		return
	}
	if !s.requireDemoWork(w, r, workID) {
		return
	}

	userID := optionalUserID(r.Context())
	current, err := s.loadWorkDetail(r.Context(), userID, workID, false)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	baseUpdatedAt := current.UpdatedAt
	var fetched workMetadataPreviewValues
	provider, sourceCode, sourceName := "dlsite", "dlsite", "DLsite"
	previewCtx, cancel := context.WithTimeout(r.Context(), remoteMetadataFallbackTimeout)
	defer cancel()
	var previewRecord metadataPreviewRecord
	if options.SourceID != nil {
		source, sourceErr := s.loadMetadataRefreshSource(previewCtx, *options.SourceID)
		if sourceErr != nil {
			writeAPIError(w, http.StatusBadRequest, "metadata_source_unavailable", "metadata source is unavailable", false)
			return
		}
		provider, sourceCode, sourceName = "remote", source.Code, source.DisplayName
		fetched, previewRecord.RemoteRaw, err = s.previewRemoteWorkMetadataRaw(previewCtx, current.PrimaryCode, source)
		previewRecord.SourceID = source.ID
	} else {
		product, productErr := s.newDLsiteMetadataSyncer(previewCtx).FetchProduct(previewCtx, current.PrimaryCode)
		if productErr == nil {
			fetched = previewValuesFromDLsiteProduct(product)
			previewRecord.Product = &product
		}
		err = productErr
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
			writeAPIError(w, http.StatusGatewayTimeout, "metadata_preview_timeout", "metadata preview timed out", true)
			return
		}
		if errors.Is(err, dlsite.ErrNoProduct) || errors.Is(err, remotemetadata.ErrInvalidWork) || kikoeru.IsNotFound(err) {
			writeAPIError(w, http.StatusNotFound, "metadata_preview_not_found", "metadata was not found", false)
			return
		}
		writeAPIError(w, http.StatusBadGateway, "metadata_preview_failed", "metadata preview failed", true)
		return
	}

	previewRecord.WorkID, previewRecord.UserID = workID, actor.ID
	previewRecord.PrimaryCode, previewRecord.BaseUpdatedAt = current.PrimaryCode, baseUpdatedAt
	previewRecord.CreatedAt = time.Now().UTC()
	previewRecord.ID = s.storeMetadataPreview(previewRecord)
	currentValues := previewValuesFromWork(current)
	if currentTags, tagsErr := s.loadWorkMetadataTags(r.Context(), workID); tagsErr == nil {
		for _, tag := range currentTags.Tags {
			currentValues.TagItems = append(currentValues.TagItems, workMetadataPreviewTag{ID: tag.ID, Name: tag.DisplayName})
		}
	}
	writeJSON(w, http.StatusOK, workMetadataPreviewResponse{
		PreviewID: previewRecord.ID, WorkID: workID, PrimaryCode: current.PrimaryCode, Provider: provider,
		SourceCode: sourceCode, SourceName: sourceName, BaseUpdatedAt: baseUpdatedAt,
		Current: currentValues, Fetched: fetched,
	})
}

func (s *Server) storeMetadataPreview(record metadataPreviewRecord) string {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		token = [16]byte{}
	}
	record.ID = hex.EncodeToString(token[:])
	s.metadataPreviewMu.Lock()
	defer s.metadataPreviewMu.Unlock()
	if s.metadataPreviews == nil {
		s.metadataPreviews = map[string]metadataPreviewRecord{}
	}
	now := time.Now().UTC()
	for id, item := range s.metadataPreviews {
		if now.Sub(item.CreatedAt) > metadataPreviewTTL {
			delete(s.metadataPreviews, id)
		}
	}
	if len(s.metadataPreviews) >= metadataPreviewLimit {
		oldestID := ""
		var oldest time.Time
		for id, item := range s.metadataPreviews {
			if oldestID == "" || item.CreatedAt.Before(oldest) {
				oldestID, oldest = id, item.CreatedAt
			}
		}
		if oldestID != "" {
			delete(s.metadataPreviews, oldestID)
		}
	}
	s.metadataPreviews[record.ID] = record
	return record.ID
}

func (s *Server) loadMetadataPreview(id string, userID, workID int64) (metadataPreviewRecord, bool) {
	s.metadataPreviewMu.Lock()
	defer s.metadataPreviewMu.Unlock()
	record, ok := s.metadataPreviews[strings.TrimSpace(id)]
	if !ok || record.UserID != userID || record.WorkID != workID || time.Since(record.CreatedAt) > metadataPreviewTTL {
		return metadataPreviewRecord{}, false
	}
	return record, true
}

func (s *Server) discardMetadataPreview(id string) {
	s.metadataPreviewMu.Lock()
	delete(s.metadataPreviews, strings.TrimSpace(id))
	s.metadataPreviewMu.Unlock()
}

// applyWorkMetadataPreview applies provider selections using the privately
// retained product or validated remote response that the preview displayed. A selected
// provider value clears an older manual override; a value the user edits or
// explicitly keeps is written as a manual override after the provider update.
func (s *Server) applyWorkMetadataPreview(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermissions(w, r, "library:write", "metadata:sync")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.workIDExists(r.Context(), workID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	var payload workMetadataPreviewApplyRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_metadata_preview", "invalid metadata preview", false)
		return
	}
	if payload.SourceID != nil && *payload.SourceID <= 0 {
		writeAPIError(w, http.StatusBadRequest, "invalid_metadata_source", "invalid metadata source", false)
		return
	}
	for field, selection := range payload.Selections {
		if !previewSelectionField(field) || (selection != "current" && selection != "fetched" && selection != "manual" && selection != "merged") {
			writeAPIError(w, http.StatusBadRequest, "invalid_metadata_preview", "invalid metadata preview selection", false)
			return
		}
	}
	preview, previewOK := s.loadMetadataPreview(payload.PreviewID, user.ID, workID)
	if !previewOK {
		writeAPIError(w, http.StatusConflict, "metadata_preview_expired", "metadata preview expired", false)
		return
	}
	payload.BaseUpdatedAt = preview.BaseUpdatedAt
	if !s.previewBaseIsCurrent(r.Context(), workID, payload.BaseUpdatedAt) {
		writeAPIError(w, http.StatusConflict, "metadata_preview_stale", "metadata changed while the preview was open", false)
		return
	}

	providerFields := false
	for _, selection := range payload.Selections {
		providerFields = providerFields || selection == "fetched" || selection == "merged"
	}
	providerSync := providerFields || payload.Selections["family"] == "fetched"
	if providerSync {
		if err := s.applyPreviewProvider(r.Context(), workID, preview, payload.Selections["family"] == "fetched", payload.Selections["cover"] == "fetched"); err != nil {
			if errors.Is(err, errMetadataSourceUnavailable) {
				writeAPIError(w, http.StatusBadRequest, "metadata_source_unavailable", "metadata source is unavailable", false)
				return
			}
			if errors.Is(err, dlsite.ErrNoProduct) || errors.Is(err, remotemetadata.ErrInvalidWork) || kikoeru.IsNotFound(err) {
				writeAPIError(w, http.StatusNotFound, "metadata_preview_not_found", "metadata was not found", false)
				return
			}
			writeAPIError(w, http.StatusBadGateway, "metadata_preview_failed", "metadata could not be saved", true)
			return
		}
	}
	if err := s.applyPreviewManualOverrides(r.Context(), workID, user.ID, payload); err != nil {
		writeManualOverrideError(w, err)
		return
	}
	s.discardMetadataPreview(preview.ID)
	var updatedAt string
	if err := s.db.QueryRowContext(r.Context(), "SELECT updated_at FROM work WHERE id = ?", workID).Scan(&updatedAt); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "updatedAt": updatedAt})
}

func previewSelectionField(field string) bool {
	switch field {
	case "title", "description", "releaseDate", "ageRating", "circle", "series", "tags", "voiceActors", "cover", "family":
		return true
	default:
		return false
	}
}

func (s *Server) previewBaseIsCurrent(ctx context.Context, workID int64, expected string) bool {
	if strings.TrimSpace(expected) == "" {
		return true
	}
	var current string
	if err := s.db.QueryRowContext(ctx, "SELECT updated_at FROM work WHERE id = ?", workID).Scan(&current); err != nil {
		return false
	}
	return strings.TrimSpace(current) == strings.TrimSpace(expected)
}

func (s *Server) applyPreviewProvider(ctx context.Context, workID int64, preview metadataPreviewRecord, acceptFamily, acceptCover bool) error {
	code := preview.PrimaryCode
	applyCtx, cancel := context.WithTimeout(ctx, remoteMetadataFallbackTimeout)
	defer cancel()
	if acceptFamily && preview.SourceID == 0 {
		_, err := s.syncWorkMetadataFamilyWithBonus(applyCtx, code, s.settingBoolContext(applyCtx, purchaseBonusAutoLinkSetting, true))
		return err
	}
	if preview.SourceID != 0 {
		source, err := s.loadMetadataRefreshSource(applyCtx, preview.SourceID)
		if err != nil {
			return err
		}
		outcome, _, err := s.applyRemoteWorkMetadataRaw(applyCtx, workID, code, source, preview.RemoteRaw, false)
		if err != nil {
			return err
		}
		if outcome != remoteFallbackFilled {
			return remotemetadata.ErrInvalidWork
		}
		return nil
	}
	if preview.Product == nil {
		return errors.New("metadata preview product missing")
	}
	syncer := s.newDLsiteMetadataSyncer(applyCtx)
	var err error
	if acceptCover {
		_, err = syncer.SyncProductOnlyWithCover(applyCtx, *preview.Product)
	} else {
		_, err = syncer.SyncProductOnly(applyCtx, *preview.Product)
	}
	return err
}

func (s *Server) applyPreviewManualOverrides(ctx context.Context, workID, userID int64, payload workMetadataPreviewApplyRequest) error {
	providerFields := false
	for _, selection := range payload.Selections {
		providerFields = providerFields || selection == "fetched" || selection == "merged"
	}
	manual := workManualOverridePayload{}
	fields := map[string]bool{}
	if selection, ok := payload.Selections["title"]; ok && (selection == "manual" || (providerFields && selection == "current")) {
		language := dlsite.NormalizeMetadataLanguage(payload.Values.TitleLanguage)
		if language != "" && language != dlsite.OriginMetadataLanguage {
			manual.Titles = map[string]*string{language: stringPointer(strings.TrimSpace(payload.Values.Title))}
			fields["titles"] = true
		} else {
			manual.Title = stringPointer(strings.TrimSpace(payload.Values.Title))
			fields["title"] = true
		}
	} else if payload.Selections["title"] == "fetched" {
		language := strings.TrimSpace(payload.Values.TitleLanguage)
		manual.Titles = map[string]*string{language: nil}
		if language != "" {
			manual.Titles[""] = nil
		}
		fields["titles"] = true
	}
	if selection, ok := payload.Selections["description"]; ok && (selection == "manual" || (providerFields && selection == "current")) {
		manual.Description = stringPointer(strings.TrimSpace(payload.Values.Description))
		fields["description"] = true
	} else if payload.Selections["description"] == "fetched" {
		manual.Description = nil
		fields["description"] = true
	}
	if selection, ok := payload.Selections["releaseDate"]; ok && (selection == "manual" || (providerFields && selection == "current")) {
		manual.ReleaseDate = payload.Values.ReleaseDate
		fields["releaseDate"] = true
	} else if payload.Selections["releaseDate"] == "fetched" {
		manual.ReleaseDate = nil
		fields["releaseDate"] = true
	}
	if selection, ok := payload.Selections["ageRating"]; ok && (selection == "manual" || (providerFields && selection == "current")) {
		manual.AgeRating = stringPointer(strings.TrimSpace(payload.Values.AgeRating))
		fields["ageRating"] = true
	} else if payload.Selections["ageRating"] == "fetched" {
		manual.AgeRating = nil
		fields["ageRating"] = true
	}
	if selection, ok := payload.Selections["circle"]; ok && (selection == "manual" || (providerFields && selection == "current")) {
		if strings.TrimSpace(payload.Values.Circle) == "" && strings.TrimSpace(payload.Values.CircleExternalID) == "" {
			manual.Circle = nil
		} else {
			manual.Circle = &manualOverrideEntity{Name: strings.TrimSpace(payload.Values.Circle), ExternalID: strings.ToUpper(strings.TrimSpace(payload.Values.CircleExternalID))}
		}
		fields["circle"] = true
	} else if payload.Selections["circle"] == "fetched" {
		manual.Circle = nil
		fields["circle"] = true
	}
	if payload.Selections["series"] == "fetched" {
		manual.Series = nil
		fields["series"] = true
	}
	if selection, ok := payload.Selections["voiceActors"]; ok && (selection == "manual" || (providerFields && selection == "current")) {
		for _, name := range payload.Values.VoiceActors {
			if name = strings.TrimSpace(name); name != "" {
				manual.VoiceActors = append(manual.VoiceActors, manualOverridePerson{Name: name})
			}
		}
		fields["voiceActors"] = true
	} else if payload.Selections["voiceActors"] == "fetched" {
		manual.VoiceActors = []manualOverridePerson{}
		fields["voiceActors"] = true
	}
	if payload.Selections["tags"] == "fetched" || payload.Selections["tags"] == "merged" || (providerFields && payload.Selections["tags"] == "current") {
		fields["tags"] = true
	}
	if len(fields) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for field := range fields {
		if field == "tags" {
			continue
		}
		if err := patchManualOverride(ctx, tx, workID, field, manual, userID); err != nil {
			return err
		}
	}
	if fields["tags"] {
		overrides := []metadatatags.Override{}
		if payload.Selections["tags"] != "fetched" {
			fetchedIDs := map[int64]bool{}
			for _, tag := range payload.FetchedTags {
				if tag.ID > 0 {
					fetchedIDs[tag.ID] = true
				}
			}
			for _, tag := range payload.CurrentTags {
				if tag.ID > 0 && !fetchedIDs[tag.ID] {
					overrides = append(overrides, metadatatags.Override{TagID: tag.ID, Action: "add"})
				}
			}
		}
		if err := metadatatags.SetOverridesTx(ctx, tx, workID, overrides, userID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func stringPointer(value string) *string {
	return &value
}

func previewValuesFromWork(work workDetail) workMetadataPreviewValues {
	family := make([]workMetadataPreviewFamilyEdition, 0, len(work.Translations))
	for _, edition := range work.Translations {
		family = append(family, workMetadataPreviewFamilyEdition{
			Code: edition.PrimaryCode, Language: edition.MetadataLanguage, Label: edition.EditionLabel,
			Origin: edition.Origin, Available: edition.LocalAvailable || edition.HasMedia,
		})
	}
	return workMetadataPreviewValues{
		Title: work.Title, TitleLanguage: work.MetadataLanguage, Description: work.Description,
		ReleaseDate: work.ReleaseDate, AgeRating: work.AgeRating, Circle: work.Circle,
		Series: work.Series,
		Rating: work.Rating, Sales: work.Sales, RegularPrice: work.RegularPrice, Price: work.Price,
		PriceCurrency: work.PriceCurrency, PermanentlyFree: work.PermanentlyFree,
		CircleExternalID: work.CircleExternalID, Tags: append([]string(nil), work.Tags...),
		VoiceActors: append([]string(nil), work.VoiceActors...), CoverAvailable: strings.TrimSpace(work.CoverURL) != "",
		Family: family,
	}
}

func previewValuesFromDLsiteProduct(product dlsite.Product) workMetadataPreviewValues {
	title := strings.TrimSpace(product.ProductName)
	if title == "" {
		title = strings.TrimSpace(product.WorkName)
	}
	if title == "" {
		title = strings.TrimSpace(product.WorkNo)
	}
	description := strings.TrimSpace(product.IntroShort)
	if description == "" {
		description = strings.TrimSpace(product.Intro)
	}
	series := ""
	var seriesFields struct {
		SeriesName string `json:"series_name"`
		Series     string `json:"series"`
	}
	if len(product.ProductRaw) > 0 {
		_ = json.Unmarshal(product.ProductRaw, &seriesFields)
	}
	series = strings.TrimSpace(firstNonEmpty(seriesFields.SeriesName, seriesFields.Series))
	actors := []string{}
	seenActors := map[string]bool{}
	for _, creator := range product.Creators["voice_by"] {
		name := strings.TrimSpace(creator.Name)
		key := strings.ToLower(name)
		if name == "" || seenActors[key] {
			continue
		}
		seenActors[key] = true
		actors = append(actors, name)
	}
	tags := []string{}
	seenTags := map[string]bool{}
	for _, genre := range product.Genres {
		name := strings.TrimSpace(genre.Name)
		if name == "" {
			name = strings.TrimSpace(genre.NameBase)
		}
		key := strings.ToLower(name)
		if name == "" || seenTags[key] {
			continue
		}
		seenTags[key] = true
		tags = append(tags, name)
	}
	tagItems := []workMetadataPreviewTag{}
	for _, genre := range product.Genres {
		name := strings.TrimSpace(genre.Name)
		if name == "" {
			name = strings.TrimSpace(genre.NameBase)
		}
		if name != "" && genre.ID > 0 {
			tagItems = append(tagItems, workMetadataPreviewTag{ID: int64(genre.ID), Name: name})
		}
	}
	language := previewProductLanguage(product)
	originCode := previewOriginCode(product.LanguageEditions)
	family := make([]workMetadataPreviewFamilyEdition, 0, len(product.LanguageEditions))
	for _, edition := range product.LanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if code == "" {
			continue
		}
		family = append(family, workMetadataPreviewFamilyEdition{
			Code: code, Language: firstNonEmptyPreviewLanguage(edition.Lang, edition.Label), Label: strings.TrimSpace(edition.Label),
			Origin: strings.EqualFold(code, originCode), Available: true,
		})
	}
	return workMetadataPreviewValues{
		Title: title, TitleLanguage: language, Description: description, Series: series,
		ReleaseDate: previewStringPointer(product.RegistDate), AgeRating: strings.TrimSpace(product.AgeCategoryString),
		Rating: product.RateAverage2DP, Sales: product.SalesCount, RegularPrice: product.RegularPrice, Price: product.CurrentPrice,
		PriceCurrency: "JPY", PermanentlyFree: product.IsPermanentlyFree(),
		Circle: strings.TrimSpace(product.MakerName), CircleExternalID: strings.ToUpper(strings.TrimSpace(product.MakerID)),
		Tags: tags, TagItems: tagItems, VoiceActors: actors, CoverAvailable: strings.TrimSpace(product.ImageMain.URL) != "", Family: family,
	}
}

func previewProductLanguage(product dlsite.Product) string {
	code := strings.ToUpper(strings.TrimSpace(product.WorkNo))
	for _, edition := range product.LanguageEditions {
		if strings.EqualFold(strings.TrimSpace(edition.WorkNo), code) {
			return firstNonEmptyPreviewLanguage(edition.Lang, edition.Label)
		}
	}
	return firstNonEmptyPreviewLanguage(product.Language, product.TranslationInfo.Lang)
}

func previewOriginCode(editions []dlsite.LanguageEdition) string {
	code := ""
	order := 0
	for index, edition := range editions {
		candidate := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if candidate == "" {
			continue
		}
		candidateOrder := edition.DisplayOrder
		if candidateOrder <= 0 {
			candidateOrder = index + 1
		}
		if code == "" || candidateOrder < order {
			code, order = candidate, candidateOrder
		}
	}
	return code
}

func firstNonEmptyPreviewLanguage(values ...string) string {
	for _, value := range values {
		if normalized := dlsite.EditionMetadataLanguage(value); normalized != "" {
			return normalized
		}
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func previewStringPointer(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func (s *Server) previewRemoteWorkMetadataRaw(ctx context.Context, code string, source remoteSourceForUse) (workMetadataPreviewValues, []byte, error) {
	_, raw, err := s.remoteMetadataClient(ctx, source).WorkInfo(ctx, code)
	if err != nil {
		return workMetadataPreviewValues{}, nil, err
	}
	remote, err := remotemetadata.Decode(raw)
	if err != nil || !strings.EqualFold(remote.Code, code) {
		if err == nil {
			err = remotemetadata.ErrInvalidWork
		}
		return workMetadataPreviewValues{}, nil, err
	}
	work := workMetadataPreviewValues{
		Title: remote.Title, TitleLanguage: "", Description: "", AgeRating: remote.AgeRating,
		ReleaseDate: previewStringPointer(remote.Release), Circle: remote.Circle,
		CoverAvailable: remote.CoverURL != "", Tags: []string{}, VoiceActors: []string{}, Family: []workMetadataPreviewFamilyEdition{},
	}
	for _, tag := range remote.Tags {
		name := strings.TrimSpace(tag.Name)
		if name != "" {
			work.Tags = append(work.Tags, name)
		}
	}
	return work, append([]byte(nil), raw...), nil
}
