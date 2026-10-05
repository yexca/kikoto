package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

// Older snapshots can predate both genre relations and metadata variants. They
// are still provider input; normalize their declared tags instead of dropping
// them when the global backfill finishes. No provider requests are made here.
func snapshotTagNamesTx(ctx context.Context, tx *sql.Tx, workID int64) ([]string, error) {
	var raw, locale string
	err := tx.QueryRowContext(ctx, `SELECT snapshot.snapshot_json,snapshot.request_locale FROM metadata_snapshot AS snapshot
 JOIN metadata_provider AS provider ON provider.id=snapshot.provider_id WHERE snapshot.work_id=? AND provider.code='dlsite'
 ORDER BY snapshot.fetched_at DESC,snapshot.id DESC LIMIT 1`, workID).Scan(&raw, &locale)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entries, embeddedLocale, declared, decodeErr := decodeSnapshotTags(raw)
	if decodeErr != nil {
		slog.Warn("skipping metadata tag snapshot fallback", "work_id", workID, "reason", decodeErr)
		return nil, nil
	}
	if !declared {
		return nil, nil
	}
	locale = snapshotRequestLocale(locale)
	if locale == "" {
		locale = embeddedLocale
	}
	// Validate the entire input before replacing any normalized relations.
	if _, err := tx.ExecContext(ctx, "DELETE FROM work_dlsite_genre WHERE work_id=?", workID); err != nil {
		return nil, err
	}
	names := []string{}
	for _, genre := range entries {
		name := genre.name
		if name == "" {
			name = genre.base
		}
		if name != "" {
			names = append(names, name)
		}
		id := genre.id
		if id <= 0 {
			continue
		}
		for _, value := range []struct{ language, name string }{{"ja-jp", genre.base}, {locale, genre.name}} {
			if value.name == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (?,?,?)
    ON CONFLICT(genre_id,language) DO NOTHING`, id, value.language, value.name); err != nil {
				return nil, err
			}
		}
		if _, err := metadatatags.EnsureGenreTx(ctx, tx, id); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO work_dlsite_genre(work_id,genre_id) VALUES (?,?) ON CONFLICT DO NOTHING", workID, id); err != nil {
			return nil, err
		}
	}
	return names, nil
}

// Unknown request language stays unscoped; name_base explicitly means Japanese.
// Invalid and over-limit tag sets are skipped as a unit, never partly applied.
type snapshotGenre struct {
	id         int64
	name, base string
}

func decodeSnapshotTags(raw string) ([]snapshotGenre, string, bool, error) {
	if len(raw) > 8<<20 {
		return nil, "", false, errors.New("snapshot size limit")
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil || envelope == nil {
		return nil, "", false, errors.New("invalid snapshot object")
	}
	payload := envelope
	if product, ok := envelope["product"]; ok {
		if err := json.Unmarshal(product, &payload); err != nil || payload == nil {
			return nil, "", false, errors.New("invalid product object")
		}
	}
	encoded, declared := payload["genres"]
	if !declared {
		encoded, declared = payload["tags"]
	}
	if !declared {
		return nil, "", false, nil
	}
	var entries []json.RawMessage
	if !strings.HasPrefix(strings.TrimSpace(string(encoded)), "[") {
		return nil, "", false, errors.New("invalid tag array")
	}
	if err := json.Unmarshal(encoded, &entries); err != nil {
		return nil, "", false, errors.New("invalid tag array")
	}
	if len(entries) > 256 {
		return nil, "", false, errors.New("tag count limit")
	}
	var meta struct {
		Locale string `json:"request_locale"`
	}
	if encoded := envelope["_kikoto"]; len(encoded) > 0 {
		if err := json.Unmarshal(encoded, &meta); err != nil {
			return nil, "", false, errors.New("invalid locale object")
		}
	}
	result := make([]snapshotGenre, 0, len(entries))
	for _, entry := range entries {
		var value snapshotGenre
		if json.Unmarshal(entry, &value.name) != nil {
			var genre struct {
				ID   json.RawMessage `json:"id"`
				Name string          `json:"name"`
				Base string          `json:"name_base"`
			}
			if err := json.Unmarshal(entry, &genre); err != nil {
				return nil, "", false, errors.New("invalid tag object")
			}
			value.name, value.base = genre.Name, genre.Base
			if len(genre.ID) > 0 && json.Unmarshal(genre.ID, &value.id) != nil {
				var text string
				if json.Unmarshal(genre.ID, &text) == nil {
					value.id, _ = strconv.ParseInt(text, 10, 64)
				}
			}
		}
		value.name, value.base = strings.TrimSpace(value.name), strings.TrimSpace(value.base)
		if len(value.name) > 512 || len(value.base) > 512 {
			return nil, "", false, errors.New("tag name limit")
		}
		result = append(result, value)
	}
	return result, snapshotRequestLocale(meta.Locale), true, nil
}

func snapshotRequestLocale(value string) string {
	locale := dlsite.NormalizeMetadataLanguage(value)
	if locale == dlsite.OriginMetadataLanguage {
		return ""
	}
	return locale
}
