package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/library"
)

var recommendationContextIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{0,64}$`)

type recommendationEventInput struct {
	WorkID           *int64 `json:"workId"`
	EventType        string `json:"eventType"`
	ContextID        string `json:"contextId"`
	AlgorithmVersion string `json:"algorithmVersion"`
	Seed             int64  `json:"seed"`
	Rank             int    `json:"rank"`
	Score            int    `json:"score"`
}

type recommendationTelemetrySummary struct {
	WindowDays   int            `json:"windowDays"`
	TotalEvents  int            `json:"totalEvents"`
	EventCounts  map[string]int `json:"eventCounts"`
	ScoreBuckets map[string]int `json:"scoreBuckets"`
	GeneratedAt  string         `json:"generatedAt"`
}

func (s *Server) workRecommendationScore(ctx context.Context, userID, workID int64) (int, error) {
	return s.libraryStore.RecommendationScore(ctx, userID, workID)
}

func (s *Server) getWorkRecommendation(w http.ResponseWriter, r *http.Request) {
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.requireDemoWork(w, r, workID) {
		return
	}
	breakdown, err := s.libraryStore.RecommendationBreakdown(r.Context(), optionalUserID(r.Context()), workID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, breakdown)
}

func (s *Server) recordRecommendationEvents(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	var payload struct {
		Events []recommendationEventInput `json:"events"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if len(payload.Events) == 0 || len(payload.Events) > 100 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "events must contain between 1 and 100 items"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	for _, event := range payload.Events {
		event.EventType = strings.ToLower(strings.TrimSpace(event.EventType))
		if !validRecommendationEventType(event.EventType) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported recommendation event type"})
			return
		}
		if !recommendationContextIDPattern.MatchString(event.ContextID) || event.Rank < 0 || event.Rank > 10000 || event.Score < 0 || event.Score > 100 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid recommendation event fields"})
			return
		}
		if event.EventType != "reshuffle" && (event.WorkID == nil || *event.WorkID <= 0) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "workId is required for this recommendation event"})
			return
		}
		algorithmVersion := strings.TrimSpace(event.AlgorithmVersion)
		if algorithmVersion == "" {
			algorithmVersion = library.RecommendationAlgorithmVersion
		}
		if len(algorithmVersion) > 32 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "algorithmVersion is too long"})
			return
		}
		var workID any
		if event.WorkID != nil {
			workID = *event.WorkID
		}
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO recommendation_event (user_id, work_id, event_type, context_id, algorithm_version, seed, rank, score)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`, user.ID, workID, event.EventType, event.ContextID, algorithmVersion, event.Seed, event.Rank, event.Score); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int{"recorded": len(payload.Events)})
}

func (s *Server) getRecommendationTelemetry(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	const windowDays = 30
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT event_type, COUNT(*)
		FROM recommendation_event
		WHERE created_at >= datetime('now', '-30 days')
		GROUP BY event_type
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	counts := map[string]int{}
	total := 0
	for rows.Next() {
		var eventType string
		var count int
		if err := rows.Scan(&eventType, &count); err != nil {
			_ = rows.Close()
			writeError(w, err)
			return
		}
		counts[eventType] = count
		total += count
	}
	if err := rows.Close(); err != nil {
		writeError(w, err)
		return
	}
	bucketRows, err := s.db.QueryContext(r.Context(), `
		SELECT CASE WHEN score < 20 THEN '0-19' WHEN score < 40 THEN '20-39' WHEN score < 60 THEN '40-59' WHEN score < 80 THEN '60-79' ELSE '80-100' END, COUNT(*)
		FROM recommendation_event
		WHERE event_type = 'impression' AND created_at >= datetime('now', '-30 days')
		GROUP BY 1 ORDER BY 1
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	buckets := map[string]int{"0-19": 0, "20-39": 0, "40-59": 0, "60-79": 0, "80-100": 0}
	for bucketRows.Next() {
		var bucket string
		var count int
		if err := bucketRows.Scan(&bucket, &count); err != nil {
			_ = bucketRows.Close()
			writeError(w, err)
			return
		}
		buckets[bucket] = count
	}
	if err := bucketRows.Close(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, recommendationTelemetrySummary{
		WindowDays: windowDays, TotalEvents: total, EventCounts: counts, ScoreBuckets: buckets, GeneratedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func validRecommendationEventType(value string) bool {
	switch value {
	case "impression", "open", "play", "positive_mark", "paused_mark", "reshuffle":
		return true
	default:
		return false
	}
}
