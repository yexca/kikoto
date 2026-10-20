package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// A voice route key addresses a person in voice detail URLs
// (/voices/{routeKey}). It is the person's canonical DLsite voice actor id, or
// local-{person.id} for a person without one. person.id stays the identity; the
// key only addresses it. The canonical DLsite id is the built-in DLsite
// provider's numeric voice_actor_id that is primary, then the lowest row id.
// Remote-source voice actor ids never become route keys.
const voiceLocalRouteKeyPrefix = "local-"

// voiceDLsiteRouteIDSQL filters person_external_id rows aliased as alias to
// the ids that can be route keys.
func voiceDLsiteRouteIDSQL(alias string) string {
	return alias + `.provider_id = (SELECT id FROM metadata_provider WHERE code = 'dlsite')
		AND ` + alias + `.id_type = 'voice_actor_id'
		AND ` + alias + `.external_id <> ''
		AND ` + alias + `.external_id NOT GLOB '*[^0-9]*'`
}

// voiceRouteKeySQL is an SQL expression for the route key of the person whose
// id is the SQL expression personID.
func voiceRouteKeySQL(personID string) string {
	return `COALESCE((
		SELECT route_external.external_id
		FROM person_external_id AS route_external
		WHERE route_external.person_id = ` + personID + `
			AND ` + voiceDLsiteRouteIDSQL("route_external") + `
		ORDER BY route_external.is_primary DESC, route_external.id ASC
		LIMIT 1
	), '` + voiceLocalRouteKeyPrefix + `' || ` + personID + `)`
}

// voiceLocalRouteKey is the route key of a person without a DLsite voice
// actor id.
func voiceLocalRouteKey(personID int64) string {
	return voiceLocalRouteKeyPrefix + strconv.FormatInt(personID, 10)
}

type voiceRoute struct {
	PersonID int64  `json:"personId"`
	RouteKey string `json:"routeKey"`
}

// resolveVoiceRouteKey returns the person a route key addresses with that
// person's canonical key, or sql.ErrNoRows. A non-canonical DLsite id of the
// person, and the local key of a person that has a DLsite id, resolve too.
func (s *Server) resolveVoiceRouteKey(ctx context.Context, key string) (voiceRoute, error) {
	key = strings.TrimSpace(key)
	var route voiceRoute
	if raw, ok := strings.CutPrefix(key, voiceLocalRouteKeyPrefix); ok {
		personID, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || personID <= 0 || strconv.FormatInt(personID, 10) != raw {
			return voiceRoute{}, sql.ErrNoRows
		}
		err = s.db.QueryRowContext(ctx, `
			SELECT person.id, `+voiceRouteKeySQL("person.id")+`
			FROM person
			WHERE person.id = ?
		`, personID).Scan(&route.PersonID, &route.RouteKey)
		return route, err
	}
	if key == "" || strings.Trim(key, "0123456789") != "" {
		return voiceRoute{}, sql.ErrNoRows
	}
	err := s.db.QueryRowContext(ctx, `
		SELECT person.id, `+voiceRouteKeySQL("person.id")+`
		FROM person_external_id AS external
		INNER JOIN person ON person.id = external.person_id
		WHERE external.external_id = ? AND `+voiceDLsiteRouteIDSQL("external")+`
	`, key).Scan(&route.PersonID, &route.RouteKey)
	return route, err
}

// voiceRouteKeys returns the route key of each person.
func (s *Server) voiceRouteKeys(ctx context.Context, personIDs []int64) (map[int64]string, error) {
	keys := map[int64]string{}
	unique := make([]int64, 0, len(personIDs))
	for _, personID := range personIDs {
		if personID <= 0 {
			continue
		}
		if _, seen := keys[personID]; seen {
			continue
		}
		keys[personID] = voiceLocalRouteKey(personID)
		unique = append(unique, personID)
	}
	err := s.queryInt64Batches(ctx, `
		SELECT person.id, `+voiceRouteKeySQL("person.id")+`
		FROM person
		WHERE person.id IN (%s)
	`, unique, nil, func(rows *sql.Rows) error {
		var personID int64
		var key string
		if err := rows.Scan(&personID, &key); err != nil {
			return err
		}
		keys[personID] = key
		return nil
	})
	return keys, err
}

// fillVoiceCreditRouteKeys sets the route key of every credit in place.
func (s *Server) fillVoiceCreditRouteKeys(ctx context.Context, groups ...[]voiceCredit) error {
	personIDs := []int64{}
	for _, credits := range groups {
		for _, credit := range credits {
			personIDs = append(personIDs, credit.PersonID)
		}
	}
	if len(personIDs) == 0 {
		return nil
	}
	keys, err := s.voiceRouteKeys(ctx, personIDs)
	if err != nil {
		return err
	}
	for _, credits := range groups {
		for index := range credits {
			credits[index].RouteKey = keys[credits[index].PersonID]
		}
	}
	return nil
}

func (s *Server) getVoiceRoute(w http.ResponseWriter, r *http.Request) {
	route, err := s.resolveVoiceRouteKey(r.Context(), r.PathValue("routeKey"))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "voice actor not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, route)
}
