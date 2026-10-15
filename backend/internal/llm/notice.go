package llm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// NoticeKey stores the administrator's acceptance of the external service
// notice, which LLM and ASR configuration requires.
const NoticeKey = "llm_service_notice"

// NoticeVersion changes when the notice changes materially, so the next
// administrator configuring a service accepts the new text.
const NoticeVersion = 1

type NoticeAcceptance struct {
	Version    int       `json:"version"`
	UserID     int64     `json:"userId"`
	AcceptedAt time.Time `json:"acceptedAt"`
}

// NoticeAccepted reports whether the current notice version has been accepted.
func (s *Store) NoticeAccepted(ctx context.Context) (bool, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key=?", NoticeKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var acceptance NoticeAcceptance
	if json.Unmarshal([]byte(raw), &acceptance) != nil {
		return false, nil
	}
	return acceptance.Version >= NoticeVersion, nil
}

// AcceptNotice records who accepted the current notice and when.
func (s *Store) AcceptNotice(ctx context.Context, userID int64, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.write(ctx, NoticeKey, NoticeAcceptance{Version: NoticeVersion, UserID: userID, AcceptedAt: now.UTC()})
}
