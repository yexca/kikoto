package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/library"
)

type userPreferences struct {
	DirectoryRoutingRules   []directoryRule              `json:"directoryRoutingRules"`
	RecommendationConfig    library.RecommendationConfig `json:"recommendationConfig"`
	RecommendationThreshold int                          `json:"recommendationThreshold"`
	RecommendationDefaults  library.RecommendationConfig `json:"recommendationDefaults"`
	// MetadataLanguages is the user's own metadata language priority, or nil
	// when the user has no preference and sees each work's original language.
	MetadataLanguages []string `json:"metadataLanguages"`
}

func (s *Server) loadUserPreferences(r *http.Request, userID int64) (userPreferences, error) {
	result := userPreferences{
		DirectoryRoutingRules:   s.settingDirectoryRules(r, "directory_routing_rules", defaultDirectoryRoutingRules()),
		RecommendationConfig:    s.libraryStore.LoadUserRecommendationConfig(r.Context(), userID),
		RecommendationThreshold: s.settingInt(r, "recommendation_threshold", 50),
		RecommendationDefaults:  library.DefaultRecommendationConfig(),
	}
	if languages, ok := s.userMetadataLanguages(r.Context(), userID); ok {
		result.MetadataLanguages = languages
	}
	var rules sql.NullString
	var threshold sql.NullInt64
	err := s.db.QueryRowContext(r.Context(), "SELECT directory_routing_rules, recommendation_threshold FROM user_preference WHERE user_id = ?", userID).Scan(&rules, &threshold)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if rules.Valid {
		if err := json.Unmarshal([]byte(rules.String), &result.DirectoryRoutingRules); err != nil {
			return result, err
		}
	}
	if threshold.Valid {
		result.RecommendationThreshold = int(threshold.Int64)
	}
	return result, nil
}

func (s *Server) getUserPreferences(w http.ResponseWriter, r *http.Request) {
	user, ok := userFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
		return
	}
	result, err := s.loadUserPreferences(r, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) updateUserPreferences(w http.ResponseWriter, r *http.Request) {
	user, ok := userFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
		return
	}
	var payload struct {
		DirectoryRoutingRules   *[]directoryRule              `json:"directoryRoutingRules"`
		RecommendationConfig    *library.RecommendationConfig `json:"recommendationConfig"`
		RecommendationThreshold *int                          `json:"recommendationThreshold"`
		// MetadataLanguages is a language priority, or null for no
		// preference (original language). Omitting it keeps the current choice.
		MetadataLanguages json.RawMessage `json:"metadataLanguages"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid preferences"})
		return
	}
	var rulesJSON, configJSON any
	if payload.DirectoryRoutingRules != nil {
		if len(*payload.DirectoryRoutingRules) > 20 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at most 20 folder rules are allowed"})
			return
		}
		encoded, err := json.Marshal(normalizeDirectoryRoutingRules(*payload.DirectoryRoutingRules))
		if err != nil {
			writeError(w, err)
			return
		}
		rulesJSON = string(encoded)
	}
	if payload.RecommendationConfig != nil {
		if err := library.ValidateRecommendationConfig(*payload.RecommendationConfig); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		encoded, err := json.Marshal(payload.RecommendationConfig)
		if err != nil {
			writeError(w, err)
			return
		}
		configJSON = string(encoded)
	}
	if payload.RecommendationThreshold != nil && (*payload.RecommendationThreshold < 1 || *payload.RecommendationThreshold > 100) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "recommendationThreshold must be between 1 and 100"})
		return
	}
	metadataLanguagesChanged := len(payload.MetadataLanguages) > 0
	var metadataLanguagesJSON any
	if metadataLanguagesChanged && string(payload.MetadataLanguages) != "null" {
		var values []string
		if err := json.Unmarshal(payload.MetadataLanguages, &values); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "metadataLanguages must be a list of languages or null"})
			return
		}
		languages, err := validateDLsiteMetadataLanguages(values)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		// Choosing only the original language is the same as no preference.
		if !sameMetadataLanguages(languages, defaultDLsiteMetadataLanguages) {
			encoded, err := json.Marshal(languages)
			if err != nil {
				writeError(w, err)
				return
			}
			metadataLanguagesJSON = string(encoded)
		}
	}
	_, err := s.db.ExecContext(r.Context(), `INSERT INTO user_preference (user_id, directory_routing_rules, recommendation_config, recommendation_threshold)
		VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
		directory_routing_rules = COALESCE(excluded.directory_routing_rules, user_preference.directory_routing_rules),
		recommendation_config = COALESCE(excluded.recommendation_config, user_preference.recommendation_config),
		recommendation_threshold = COALESCE(excluded.recommendation_threshold, user_preference.recommendation_threshold)`, user.ID, rulesJSON, configJSON, payload.RecommendationThreshold)
	if err != nil {
		writeError(w, err)
		return
	}
	if metadataLanguagesChanged {
		if _, err := s.db.ExecContext(r.Context(), `INSERT INTO user_preference (user_id, metadata_languages) VALUES (?, ?)
			ON CONFLICT(user_id) DO UPDATE SET metadata_languages = excluded.metadata_languages`, user.ID, metadataLanguagesJSON); err != nil {
			writeError(w, err)
			return
		}
		// A personal language may need tag names the instance never learned.
		s.queueGenreNameLearning(r.Context(), "language_priority")
	}
	s.getUserPreferences(w, r)
}
