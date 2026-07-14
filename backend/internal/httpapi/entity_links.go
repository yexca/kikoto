package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

type workEntityLinkRequest struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

type workEntityLinkResponse struct {
	Kind     string `json:"kind"`
	Route    string `json:"route"`
	Resolved bool   `json:"resolved"`
	Fetched  bool   `json:"fetched"`
}

func (s *Server) resolveWorkEntityLink(w http.ResponseWriter, r *http.Request) {
	code := normalizeDLsiteCode(r.PathValue("code"))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return
	}
	var request workEntityLinkRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	request.Kind = strings.ToLower(strings.TrimSpace(request.Kind))
	request.Name = strings.TrimSpace(request.Name)
	if request.Kind != "circle" && request.Kind != "series" && request.Kind != "voice" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be circle, series, or voice"})
		return
	}

	if route, err := s.findWorkEntityRoute(r.Context(), code, request); err != nil {
		writeError(w, err)
		return
	} else if route != "" {
		writeJSON(w, http.StatusOK, workEntityLinkResponse{Kind: request.Kind, Route: route, Resolved: true})
		return
	}
	// Relationships can lag behind an already persisted snapshot. Materialize
	// those local relationships before deciding that a provider request is
	// necessary.
	if err := s.hydrateWorkEntityLinksFromSnapshots(r.Context(), code); err != nil {
		writeError(w, err)
		return
	}
	if route, err := s.findWorkEntityRoute(r.Context(), code, request); err != nil {
		writeError(w, err)
		return
	} else if route != "" {
		writeJSON(w, http.StatusOK, workEntityLinkResponse{Kind: request.Kind, Route: route, Resolved: true})
		return
	}

	if err := s.syncWorkEntityMetadata(r.Context(), code); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not load entity metadata for this work."})
		return
	}
	if route, err := s.findWorkEntityRoute(r.Context(), code, request); err != nil {
		writeError(w, err)
		return
	} else if route != "" {
		writeJSON(w, http.StatusOK, workEntityLinkResponse{Kind: request.Kind, Route: route, Resolved: true, Fetched: true})
		return
	}

	if request.Kind == "series" {
		partyID, makerID, err := s.workCircleIdentity(r.Context(), code)
		if err != nil {
			writeError(w, err)
			return
		}
		if partyID > 0 && makerID != "" {
			_, refreshErr := s.runCircleRefresh(r.Context(), partyID, makerID, circleRefreshRequest{
				Scope: "catalog", Mode: "incremental", ProductMode: "available",
			})
			if refreshErr != nil {
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Could not load the series catalog for this circle."})
				return
			}
			if route, err := s.findWorkEntityRoute(r.Context(), code, request); err != nil {
				writeError(w, err)
				return
			} else if route != "" {
				writeJSON(w, http.StatusOK, workEntityLinkResponse{Kind: request.Kind, Route: route, Resolved: true, Fetched: true})
				return
			}
		}
	}

	writeJSON(w, http.StatusNotFound, map[string]string{"error": fmt.Sprintf("No %s link was found for this work.", request.Kind)})
}

func (s *Server) hydrateWorkEntityLinksFromSnapshots(ctx context.Context, code string) error {
	if err := s.syncPartyForWorkFromSnapshot(ctx, code); err != nil {
		return err
	}
	var workID int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	return s.syncVoiceCreditsForWorkFromSnapshots(ctx, workID)
}

func (s *Server) syncWorkEntityMetadata(ctx context.Context, code string) error {
	_, err := s.syncWorkMetadataFamily(ctx, code)
	return err
}

func (s *Server) syncWorkMetadataFamily(ctx context.Context, code string) (metasync.DLsiteFamilySyncResult, error) {
	language := normalizeDLsiteLanguage(s.settingStringContext(ctx, "dlsite_metadata_language", "ja-jp"))
	syncer := metasync.NewDLsiteSyncer(s.db, dlsite.NewClient(nil)).
		WithCacheRoot(s.cfg.CacheRoot).
		WithLanguages(dlsiteLanguageFallbacks(language)).
		WithRequestPacing(
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_rate_limit_backoff_seconds", 30)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_max_backoff_seconds", 300)),
		)
	family, err := syncer.SyncFamily(ctx, code)
	if err != nil {
		return family, err
	}
	codes := append([]string{code, family.CanonicalCode}, family.SyncedCodes...)
	seen := map[int64]bool{}
	for _, candidate := range codes {
		if err := s.syncPartyForWorkFromSnapshot(ctx, candidate); err != nil {
			return family, err
		}
		var workID int64
		if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", candidate).Scan(&workID); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return family, err
		}
		if seen[workID] {
			continue
		}
		seen[workID] = true
		if err := s.syncVoiceCreditsForWorkFromSnapshots(ctx, workID); err != nil {
			return family, err
		}
	}
	return family, nil
}

func (s *Server) syncPartyForWorkFromSnapshot(ctx context.Context, code string) error {
	var workID int64
	var primaryCode, title, raw string
	var release sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT work.id, work.primary_code, work.title, work.release_date, snapshot.snapshot_json
		FROM work
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.work_id = work.id
		INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
		WHERE UPPER(work.primary_code) = UPPER(?) AND provider.code = 'dlsite'
		ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
		LIMIT 1
	`, code).Scan(&workID, &primaryCode, &title, &release, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	party := parsePartyFromDLsiteSnapshot(raw)
	if !dlsiteMakerIDPattern.MatchString(party.ExternalID) || party.DisplayName == "" {
		return nil
	}
	partyID, err := s.upsertDLsiteParty(ctx, party.ExternalID, party.DisplayName, raw)
	if err != nil {
		return err
	}
	if err := s.upsertPartyCatalogItem(ctx, partyID, primaryCode, title, nullableStringValue(release), dlsiteURL(primaryCode), "imported", raw); err != nil {
		return err
	}
	return s.upsertWorkParty(ctx, workID, partyID, "circle", "dlsite_snapshot")
}

func (s *Server) findWorkEntityRoute(ctx context.Context, code string, request workEntityLinkRequest) (string, error) {
	switch request.Kind {
	case "circle":
		_, makerID, err := s.workCircleIdentity(ctx, code)
		if err != nil || makerID == "" {
			return "", err
		}
		return "/circles/" + url.PathEscape(makerID), nil
	case "series":
		var makerID, titleID string
		err := s.db.QueryRowContext(ctx, `
			SELECT external.external_id, series.title_id
			FROM party_series_work AS member
			INNER JOIN party_series AS series ON series.id = member.series_id
			INNER JOIN party_external_id AS external ON external.party_id = series.party_id
			INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
			WHERE UPPER(member.primary_code) = UPPER(?)
				AND provider.code = 'dlsite'
				AND external.id_type = 'maker_id'
			ORDER BY external.is_primary DESC, series.last_seen_at DESC, series.id DESC
			LIMIT 1
		`, code).Scan(&makerID, &titleID)
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		return "/circles/" + url.PathEscape(makerID) + "/series/" + url.PathEscape(titleID), nil
	case "voice":
		var personID int64
		query := `
			SELECT person.id
			FROM work
			INNER JOIN work_credit AS credit ON credit.work_id = work.id AND credit.role = 'voice_actor'
			INNER JOIN person ON person.id = credit.person_id
			WHERE UPPER(work.primary_code) = UPPER(?)`
		args := []any{code}
		if request.Name != "" {
			query += ` AND (LOWER(person.display_name) = LOWER(?) OR EXISTS (
				SELECT 1 FROM person_alias WHERE person_alias.person_id = person.id AND LOWER(person_alias.alias) = LOWER(?)
			))`
			args = append(args, request.Name, request.Name)
		}
		query += " ORDER BY person.id ASC LIMIT 1"
		err := s.db.QueryRowContext(ctx, query, args...).Scan(&personID)
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("/voices/%d", personID), nil
	}
	return "", nil
}

func (s *Server) workCircleIdentity(ctx context.Context, code string) (int64, string, error) {
	var partyID int64
	var makerID string
	err := s.db.QueryRowContext(ctx, `
		SELECT party.id, external.external_id
		FROM work
		INNER JOIN work_party AS relation ON relation.work_id = work.id AND relation.role = 'circle'
		INNER JOIN party ON party.id = relation.party_id
		INNER JOIN party_external_id AS external ON external.party_id = party.id
		INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id
		WHERE UPPER(work.primary_code) = UPPER(?)
			AND provider.code = 'dlsite'
			AND external.id_type = 'maker_id'
		ORDER BY external.is_primary DESC, relation.updated_at DESC
		LIMIT 1
	`, code).Scan(&partyID, &makerID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", nil
	}
	return partyID, makerID, err
}

func (s *Server) voiceCreditsForWork(ctx context.Context, workID int64) ([]voiceCredit, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT person.id, person.display_name
		FROM work_credit AS credit
		INNER JOIN person ON person.id = credit.person_id
		WHERE credit.work_id = ? AND credit.role = 'voice_actor'
		ORDER BY person.display_name ASC, person.id ASC
	`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	credits := []voiceCredit{}
	for rows.Next() {
		var credit voiceCredit
		if err := rows.Scan(&credit.PersonID, &credit.DisplayName); err != nil {
			return nil, err
		}
		credits = append(credits, credit)
	}
	return credits, rows.Err()
}
