package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// Metadata language has two scopes. The instance default (app_setting
// dlsite_metadata_languages) drives everything stored or shared: projected
// work titles and tag display names, background syncs, catalog snapshots,
// remote metadata fallback and Activity text. A signed-in user may choose a
// personal priority that only changes what that user's requests present:
// titles, tag names, default editions, title sorting and live remote-source
// requests. Stored provider data never depends on a personal choice.

// viewerMetadataLanguages is the normalized priority for the request's user:
// the user's own choice when set, otherwise the instance default. Requests
// without a user, including anonymous browsing, use the instance default.
func (s *Server) viewerMetadataLanguages(ctx context.Context) []string {
	memo, _ := ctx.Value(metadataLanguageMemoKey).(*metadataLanguageMemo)
	if memo != nil {
		memo.mu.Lock()
		defer memo.mu.Unlock()
		if memo.viewerLoaded {
			return append([]string(nil), memo.viewer...)
		}
	}
	languages, _ := s.loadViewerMetadataLanguages(ctx)
	if memo != nil {
		memo.viewer, memo.viewerLoaded = languages, true
		return append([]string(nil), languages...)
	}
	return languages
}

// viewerTagLanguages returns the viewer's priority when it names tags
// differently from the stored instance projection, and nil when the stored
// display names already are the viewer's names.
func (s *Server) viewerTagLanguages(ctx context.Context) []string {
	memo, _ := ctx.Value(metadataLanguageMemoKey).(*metadataLanguageMemo)
	if memo != nil {
		memo.mu.Lock()
		defer memo.mu.Unlock()
		if memo.tagLoaded {
			return append([]string(nil), memo.tag...)
		}
	}
	viewer, personal := s.loadViewerMetadataLanguages(ctx)
	var languages []string
	if personal && !sameMetadataLanguages(viewer, s.instanceMetadataLanguages(ctx)) {
		languages = viewer
	}
	if memo != nil {
		memo.tag, memo.tagLoaded = languages, true
		return append([]string(nil), languages...)
	}
	return languages
}

// titleSortLanguages is the viewer's priority for a title sort, so a list
// orders works by the titles this viewer sees. Other sorts need none.
func (s *Server) titleSortLanguages(ctx context.Context, sort string) []string {
	if !strings.EqualFold(strings.TrimSpace(sort), "title") {
		return nil
	}
	return s.viewerMetadataLanguages(ctx)
}

func (s *Server) loadViewerMetadataLanguages(ctx context.Context) ([]string, bool) {
	if user, ok := userFromContext(ctx); ok && user.ID > 0 {
		if languages, ok := s.userMetadataLanguages(ctx, user.ID); ok {
			return languages, true
		}
	}
	return s.instanceMetadataLanguages(ctx), false
}

// metadataLanguageMemo resolves a request's viewer languages once, because a
// page may present many works. Only read paths use it: a request that changes
// a language setting reads the stored values directly.
type metadataLanguageMemo struct {
	mu           sync.Mutex
	viewer, tag  []string
	viewerLoaded bool
	tagLoaded    bool
}

const metadataLanguageMemoKey contextKey = "metadataLanguageMemo"

func withMetadataLanguageMemo(ctx context.Context) context.Context {
	return context.WithValue(ctx, metadataLanguageMemoKey, &metadataLanguageMemo{})
}

// userMetadataLanguages returns the user's own normalized priority and false
// when the user follows the instance default. An unreadable stored value
// follows the instance default rather than failing the request.
func (s *Server) userMetadataLanguages(ctx context.Context, userID int64) ([]string, bool) {
	if s.db == nil {
		return nil, false
	}
	var raw sql.NullString
	err := s.db.QueryRowContext(ctx, "SELECT metadata_languages FROM user_preference WHERE user_id = ?", userID).Scan(&raw)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) && ctx.Err() == nil {
			slog.Warn("read user metadata language", "error", err)
		}
		return nil, false
	}
	if !raw.Valid {
		return nil, false
	}
	var values []string
	if json.Unmarshal([]byte(raw.String), &values) != nil {
		return nil, false
	}
	normalized, ok := parseDLsiteMetadataLanguages(values)
	if !ok {
		return nil, false
	}
	return completeDLsiteMetadataLanguages(normalized), true
}

// sameMetadataLanguages reports whether two normalized priorities present the
// same names, so a viewer on the instance default can reuse projected values.
func sameMetadataLanguages(left, right []string) bool {
	left, right = dlsite.NormalizeMetadataPriority(left), dlsite.NormalizeMetadataPriority(right)
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

// learnedMetadataLanguages is every language some presentation may prefer:
// the instance default and each user's own choice. Background tag name
// learning covers this union so a personal language also gets learned names.
func (s *Server) learnedMetadataLanguages(ctx context.Context) []string {
	seen := map[string]bool{}
	result := []string{}
	add := func(languages []string) {
		for _, language := range languages {
			if !seen[language] {
				seen[language] = true
				result = append(result, language)
			}
		}
	}
	add(s.instanceMetadataLanguages(ctx))
	rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT metadata_languages FROM user_preference WHERE metadata_languages IS NOT NULL")
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("read user metadata languages", "error", err)
		}
		return result
	}
	defer func() { _ = rows.Close() }()
	personal := []string{}
	for rows.Next() {
		var raw string
		if rows.Scan(&raw) != nil {
			continue
		}
		var values []string
		if json.Unmarshal([]byte(raw), &values) != nil {
			continue
		}
		if normalized, ok := parseDLsiteMetadataLanguages(values); ok {
			personal = append(personal, normalized...)
		}
	}
	sort.Strings(personal)
	add(dlsite.NormalizeMetadataPriority(personal))
	return result
}
