// Package personal owns account-scoped tags, listening history and portable data.
package personal

import (
	"database/sql"
	"errors"
)

type Store struct{ DB *sql.DB }

var (
	ErrInvalid        = errors.New("invalid personal data")
	ErrNotFound       = errors.New("personal record not found")
	ErrConflict       = errors.New("personal record already exists")
	ErrLimit          = errors.New("personal data limit exceeded")
	ErrHistoryCleared = errors.New("listening history was cleared")
)

func pageBounds(page, size int) (int, int) {
	if page < 1 {
		page = 1
	}
	if page > 1000000 {
		page = 1000000
	}
	if size < 1 || size > 100 {
		size = 50
	}
	return page, size
}
