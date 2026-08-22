package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	workflowEventStreamPollInterval = 1 * time.Second
	workflowEventStreamTickInterval = 2 * time.Second
	workflowEventStreamHeartbeat    = 15 * time.Second
)

// streamWorkflowRunEvents keeps the durable event cursor on the wire while
// the client periodically refreshes the run detail for progress fields that
// are not represented by workflow_event rows.
func (s *Server) streamWorkflowRunEvents(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
		return
	}
	afterID, err := workflowEventCursor(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow event cursor"})
		return
	}
	if _, err := s.workflowStore.LoadRun(r.Context(), id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow run not found"})
			return
		}
		writeError(w, err)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, "stream_unavailable", "event stream is unavailable", true)
		return
	}

	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	lastEventID := afterID
	lastTickAt := time.Time{}
	writeUpdate := func(forceTick bool) (string, error) {
		events, err := s.workflowStore.ListEventsAfter(r.Context(), id, lastEventID)
		if err != nil {
			return "", err
		}
		for _, event := range events {
			payload, marshalErr := json.Marshal(event)
			if marshalErr != nil {
				return "", marshalErr
			}
			if err := writeWorkflowSSE(w, flusher, "workflow", event.ID, payload); err != nil {
				return "", err
			}
			if event.ID > lastEventID {
				lastEventID = event.ID
			}
		}

		run, err := s.workflowStore.LoadRun(r.Context(), id)
		if err != nil {
			return "", err
		}
		terminal := !isActiveWorkflowRunStatus(run.Status)
		if forceTick || terminal || lastTickAt.IsZero() || time.Since(lastTickAt) >= workflowEventStreamTickInterval {
			payload, marshalErr := json.Marshal(map[string]any{
				"status":      run.Status,
				"lastEventId": lastEventID,
				"updatedAt":   time.Now().UTC().Format(time.RFC3339Nano),
			})
			if marshalErr != nil {
				return "", marshalErr
			}
			if err := writeWorkflowSSE(w, flusher, "tick", 0, payload); err != nil {
				return "", err
			}
			lastTickAt = time.Now()
		}
		return run.Status, nil
	}

	status, err := writeUpdate(true)
	if err != nil {
		slog.Debug("workflow event stream ended during initial update", "run_id", id, "error", err)
		return
	}
	if !isActiveWorkflowRunStatus(status) {
		return
	}

	pollTicker := time.NewTicker(workflowEventStreamPollInterval)
	defer pollTicker.Stop()
	heartbeatTicker := time.NewTicker(workflowEventStreamHeartbeat)
	defer heartbeatTicker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-pollTicker.C:
			status, err = writeUpdate(false)
			if err != nil {
				slog.Debug("workflow event stream ended", "run_id", id, "error", err)
				return
			}
			if !isActiveWorkflowRunStatus(status) {
				return
			}
		case <-heartbeatTicker.C:
			if _, err := fmt.Fprint(w, ": keep-alive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func isActiveWorkflowRunStatus(status string) bool {
	status = strings.ToLower(strings.TrimSpace(status))
	return status == "queued" || status == "running"
}

func workflowEventCursor(r *http.Request) (int64, error) {
	value := strings.TrimSpace(r.URL.Query().Get("afterId"))
	if value == "" {
		value = strings.TrimSpace(r.Header.Get("Last-Event-ID"))
	}
	if value == "" {
		return 0, nil
	}
	cursor, err := strconv.ParseInt(value, 10, 64)
	if err != nil || cursor < 0 {
		return 0, errors.New("invalid workflow event cursor")
	}
	return cursor, nil
}

func writeWorkflowSSE(w http.ResponseWriter, flusher http.Flusher, eventName string, eventID int64, payload []byte) error {
	if eventID > 0 {
		if _, err := fmt.Fprintf(w, "id: %d\n", eventID); err != nil {
			return err
		}
	}
	if strings.TrimSpace(eventName) != "" {
		if _, err := fmt.Fprintf(w, "event: %s\n", eventName); err != nil {
			return err
		}
	}
	for _, line := range strings.Split(string(payload), "\n") {
		if _, err := fmt.Fprintf(w, "data: %s\n", line); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprint(w, "\n"); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}
