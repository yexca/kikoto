package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

// Older snapshots can predate both genre relations and metadata variants. They
// are still provider input; normalize their declared tags instead of dropping
// them when the global backfill finishes. No provider requests are made here.
func snapshotTagNamesTx(ctx context.Context, tx *sql.Tx, workID int64) ([]string, error) {
	var raw, provider string
	err := tx.QueryRowContext(ctx, `SELECT snapshot.snapshot_json,provider.code FROM metadata_snapshot AS snapshot
 JOIN metadata_provider AS provider ON provider.id=snapshot.provider_id WHERE snapshot.work_id=?
 ORDER BY CASE WHEN provider.code='dlsite' THEN 0 ELSE 1 END,snapshot.fetched_at DESC,snapshot.id DESC LIMIT 1`, workID).Scan(&raw, &provider)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	envelope := payload
	if product := payload["product"]; len(product) > 0 {
		if err := json.Unmarshal(product, &payload); err != nil {
			return nil, err
		}
	}
	encoded, declared := payload["genres"]
	if !declared {
		encoded, declared = payload["tags"]
	}
	if !declared {
		return nil, nil
	}
	// A declared snapshot tag set replaces the older provider base, including
	// an explicitly empty set. Undeclared fields leave normalized input intact.
	if provider == "dlsite" {
		if _, err := tx.ExecContext(ctx, "DELETE FROM work_dlsite_genre WHERE work_id=?", workID); err != nil {
			return nil, err
		}
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(encoded, &entries); err != nil {
		return nil, err
	}
	if len(entries) > 256 {
		return nil, metadatatags.ErrInvalid
	}
	var meta struct {
		Locale string `json:"request_locale"`
	}
	if encoded := envelope["_kikoto"]; len(encoded) > 0 {
		if err := json.Unmarshal(encoded, &meta); err != nil {
			return nil, err
		}
	}
	locale := normalizeRequestLocale(meta.Locale)
	if locale == "" {
		locale = "ja-jp"
	}
	names := []string{}
	for _, entry := range entries {
		var name string
		var genre struct {
			ID   json.RawMessage `json:"id"`
			Name string          `json:"name"`
			Base string          `json:"name_base"`
		}
		if json.Unmarshal(entry, &name) != nil {
			if err := json.Unmarshal(entry, &genre); err != nil {
				return nil, err
			}
			name = genre.Name
			if strings.TrimSpace(name) == "" {
				name = genre.Base
			}
		}
		name = strings.TrimSpace(name)
		if len(name) > 512 {
			return nil, metadatatags.ErrInvalid
		}
		if name != "" {
			names = append(names, name)
		}
		if provider != "dlsite" || len(genre.ID) == 0 {
			continue
		}
		var id int64
		if json.Unmarshal(genre.ID, &id) != nil {
			var text string
			if json.Unmarshal(genre.ID, &text) == nil {
				id, _ = strconv.ParseInt(text, 10, 64)
			}
		}
		if id <= 0 {
			continue
		}
		for _, value := range []struct{ language, name string }{{locale, name}, {"ja-jp", strings.TrimSpace(genre.Base)}} {
			if value.name == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (?,?,?)
    ON CONFLICT(genre_id,language) DO UPDATE SET name=excluded.name WHERE dlsite_genre_name.name<>excluded.name`, id, value.language, value.name); err != nil {
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
