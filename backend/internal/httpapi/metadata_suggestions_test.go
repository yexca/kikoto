package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

type metadataSuggestionFixture struct {
	server        *Server
	actor         account.User
	alphaPartyID  int64
	betaPartyID   int64
	alphaPersonID int64
}

func newMetadataSuggestionFixture(t *testing.T) metadataSuggestionFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	fixture := metadataSuggestionFixture{
		server: NewServer(db, config.Config{}),
		actor:  account.User{ID: 1, Permissions: []string{"library:read"}},
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	alphaPartyResult, err := db.Exec("INSERT INTO party (party_type, display_name) VALUES ('circle', 'Example Circle Alpha')")
	fixture.alphaPartyID = mustSuggestionInsertID(t, alphaPartyResult, err)
	betaPartyResult, err := db.Exec("INSERT INTO party (party_type, display_name) VALUES ('circle', 'Example Circle Beta')")
	fixture.betaPartyID = mustSuggestionInsertID(t, betaPartyResult, err)
	if _, err := db.Exec(`
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
		VALUES (?, ?, 'maker_id', 'RG00000000', 1), (?, ?, 'maker_id', 'RG00000001', 1)
	`, fixture.alphaPartyID, providerID, fixture.betaPartyID, providerID); err != nil {
		t.Fatal(err)
	}
	alphaPersonResult, err := db.Exec("INSERT INTO person (display_name, sort_name) VALUES ('Example Voice Alpha', 'Example Voice Alpha')")
	fixture.alphaPersonID = mustSuggestionInsertID(t, alphaPersonResult, err)
	if _, err := db.Exec("INSERT INTO person (display_name, sort_name) VALUES ('Example Voice Beta', 'Example Voice Beta')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO person_alias (person_id, alias, source)
		VALUES (?, 'Example Stage Name', 'manual'), (?, 'Stage Example Name', 'manual')
	`, fixture.alphaPersonID, fixture.alphaPersonID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO party_series (party_id, provider_id, title_id, name)
		VALUES (?, ?, 'SRI0000000000', 'Example Series Alpha'), (?, ?, 'SRI0000000001', 'Example Series Beta')
	`, fixture.alphaPartyID, providerID, fixture.betaPartyID, providerID); err != nil {
		t.Fatal(err)
	}
	return fixture
}

type suggestionSQLResult interface {
	LastInsertId() (int64, error)
}

func mustSuggestionInsertID(t *testing.T, result suggestionSQLResult, err error) int64 {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func metadataSuggestionRequest(target string, actor *account.User) *http.Request {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	if actor == nil {
		return request
	}
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, *actor))
}

func TestMetadataSuggestionsRequireReadPermissionAndIgnoreShortQueries(t *testing.T) {
	fixture := newMetadataSuggestionFixture(t)

	unauthorized := httptest.NewRecorder()
	fixture.server.suggestCircles(unauthorized, metadataSuggestionRequest("/api/metadata-suggestions/circles?q=example", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, body = %s", unauthorized.Code, unauthorized.Body.String())
	}

	actorWithoutPermission := account.User{ID: 1, Permissions: []string{"playback:use"}}
	forbidden := httptest.NewRecorder()
	fixture.server.suggestCircles(forbidden, metadataSuggestionRequest("/api/metadata-suggestions/circles?q=example", &actorWithoutPermission))
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("forbidden status = %d, body = %s", forbidden.Code, forbidden.Body.String())
	}

	shortQuery := httptest.NewRecorder()
	fixture.server.suggestCircles(shortQuery, metadataSuggestionRequest("/api/metadata-suggestions/circles?q=e", &fixture.actor))
	var got metadataSuggestionResponse[json.RawMessage]
	if err := json.NewDecoder(shortQuery.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if shortQuery.Code != http.StatusOK || len(got.Items) != 0 || got.Truncated {
		t.Fatalf("short-query response = %#v, status = %d", got, shortQuery.Code)
	}
}

func TestMetadataSuggestionsSearchCanonicalNamesAliasesAndIdentifiers(t *testing.T) {
	fixture := newMetadataSuggestionFixture(t)

	circlesResponse := httptest.NewRecorder()
	fixture.server.suggestCircles(circlesResponse, metadataSuggestionRequest("/api/metadata-suggestions/circles?q=EXAMPLE&limit=1", &fixture.actor))
	var circles metadataSuggestionResponse[circleSuggestion]
	if err := json.NewDecoder(circlesResponse.Body).Decode(&circles); err != nil {
		t.Fatal(err)
	}
	if circlesResponse.Code != http.StatusOK || len(circles.Items) != 1 || !circles.Truncated {
		t.Fatalf("circle suggestions = %#v, status = %d", circles, circlesResponse.Code)
	}
	if circles.Items[0].PartyID != fixture.alphaPartyID || circles.Items[0].ExternalID != "RG00000000" {
		t.Fatalf("first circle suggestion = %#v", circles.Items[0])
	}

	externalIDResponse := httptest.NewRecorder()
	fixture.server.suggestCircles(externalIDResponse, metadataSuggestionRequest("/api/metadata-suggestions/circles?q=rg00000001", &fixture.actor))
	var externalIDMatches metadataSuggestionResponse[circleSuggestion]
	if err := json.NewDecoder(externalIDResponse.Body).Decode(&externalIDMatches); err != nil {
		t.Fatal(err)
	}
	if len(externalIDMatches.Items) != 1 || externalIDMatches.Items[0].PartyID != fixture.betaPartyID {
		t.Fatalf("external-id suggestions = %#v", externalIDMatches)
	}

	voicesResponse := httptest.NewRecorder()
	fixture.server.suggestVoices(voicesResponse, metadataSuggestionRequest("/api/metadata-suggestions/voices?q=stage", &fixture.actor))
	var voices metadataSuggestionResponse[voiceSuggestion]
	if err := json.NewDecoder(voicesResponse.Body).Decode(&voices); err != nil {
		t.Fatal(err)
	}
	if len(voices.Items) != 1 || voices.Items[0].PersonID != fixture.alphaPersonID || voices.Truncated {
		t.Fatalf("voice suggestions = %#v", voices)
	}

	seriesTarget := "/api/metadata-suggestions/series?q=example&circleId=" + url.QueryEscape(" rg00000001 ")
	seriesResponse := httptest.NewRecorder()
	fixture.server.suggestSeries(seriesResponse, metadataSuggestionRequest(seriesTarget, &fixture.actor))
	var series metadataSuggestionResponse[seriesSuggestion]
	if err := json.NewDecoder(seriesResponse.Body).Decode(&series); err != nil {
		t.Fatal(err)
	}
	if len(series.Items) != 1 || series.Items[0].TitleID != "SRI0000000001" || series.Items[0].CircleExternalID != "RG00000001" || series.Items[0].CircleName != "Example Circle Beta" {
		t.Fatalf("series suggestions = %#v", series)
	}
}

func TestMetadataSuggestionQueryBoundsRequestedLimit(t *testing.T) {
	tests := []struct {
		rawLimit string
		want     int
	}{
		{rawLimit: "", want: metadataSuggestionDefaultLimit},
		{rawLimit: "invalid", want: metadataSuggestionDefaultLimit},
		{rawLimit: "0", want: metadataSuggestionDefaultLimit},
		{rawLimit: "7", want: 7},
		{rawLimit: strconv.Itoa(metadataSuggestionMaxLimit + 1), want: metadataSuggestionMaxLimit},
	}
	for _, test := range tests {
		t.Run(test.rawLimit, func(t *testing.T) {
			target := "/api/metadata-suggestions/circles?q=%20Example%20"
			if test.rawLimit != "" {
				target += "&limit=" + url.QueryEscape(test.rawLimit)
			}
			response := httptest.NewRecorder()
			query, limit, ok := metadataSuggestionQuery(response, httptest.NewRequest(http.MethodGet, target, nil))
			if !ok || query != "%example%" || limit != test.want {
				t.Fatalf("query = %q, limit = %d, ok = %v; want %%example%%, %d, true", query, limit, ok, test.want)
			}
		})
	}
}
