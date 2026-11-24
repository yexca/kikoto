package httpapi

import (
	"errors"
	"strings"
)

type creatorLatestWork struct {
	PrimaryCode string  `json:"primaryCode"`
	Title       string  `json:"title"`
	ReleaseDate *string `json:"releaseDate"`
	CoverURL    string  `json:"coverUrl"`
	// CoverSourceID is the remote source a catalog cover URL came from.
	CoverSourceID int64 `json:"-"`
}

// creatorCover is the cover a circle or voice actor shows: the work the user
// chose, or the latest work while no chosen work applies.
type creatorCover struct {
	PrimaryCode string `json:"primaryCode"`
	CoverURL    string `json:"coverUrl"`
	Custom      bool   `json:"custom"`
}

// creatorCoverChoice names the works a latest-work query also reads as chosen
// covers. Its SQL yields (creator_id, code) rows and is trusted text from this
// package; only its arguments carry request values.
type creatorCoverChoice struct {
	sql  string
	args []any
}

// noCreatorCoverChoice reads no chosen cover.
var noCreatorCoverChoice = creatorCoverChoice{sql: "SELECT 0 AS creator_id, '' AS code WHERE 0"}

// savedCreatorCoverChoice reads one user's saved choices from a personal
// state table keyed by idColumn.
func savedCreatorCoverChoice(table, idColumn string, userID int64) creatorCoverChoice {
	return creatorCoverChoice{
		sql: "SELECT " + idColumn + " AS creator_id, cover_primary_code AS code FROM " + table +
			" WHERE user_id = ? AND cover_primary_code != ''",
		args: []any{userID},
	}
}

// proposedCreatorCoverChoice reads one choice before it is saved, so a request
// is checked against the same works a saved choice resolves to.
func proposedCreatorCoverChoice(creatorID int64, code string) creatorCoverChoice {
	return creatorCoverChoice{sql: "SELECT ? AS creator_id, ? AS code", args: []any{creatorID, code}}
}

var errCreatorCoverUnavailable = errors.New("work is not one of this creator's works with a cover")

// normalizeCreatorCoverCode returns the stored form of a requested cover work
// code. An empty code restores the latest work's cover.
func normalizeCreatorCoverCode(raw string) (string, error) {
	code := strings.ToUpper(strings.TrimSpace(raw))
	if code != "" && !dlsiteProductCodePattern.MatchString(code) {
		return "", errors.New("invalid work code")
	}
	return code, nil
}

// newCreatorCover prefers the chosen work and falls back to the latest one
// when the choice has no cover to show.
func newCreatorCover(chosen, latest *creatorLatestWork) *creatorCover {
	if chosen != nil && chosen.CoverURL != "" {
		return &creatorCover{PrimaryCode: chosen.PrimaryCode, CoverURL: chosen.CoverURL, Custom: true}
	}
	if latest == nil {
		return nil
	}
	return &creatorCover{PrimaryCode: latest.PrimaryCode, CoverURL: latest.CoverURL}
}

func creatorPageBounds(page int, pageSize int, total int) (int, int, int) {
	if pageSize < 1 {
		pageSize = 24
	}
	if pageSize > 100 {
		pageSize = 100
	}
	lastPage := 1
	if total > 0 {
		lastPage = (total + pageSize - 1) / pageSize
	}
	if page < 1 {
		page = 1
	}
	if page > lastPage {
		page = lastPage
	}
	start := (page - 1) * pageSize
	end := start + pageSize
	if end > total {
		end = total
	}
	return page, start, end
}
