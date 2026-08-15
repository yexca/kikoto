package migrations

import "embed"

// Files is the versioned migration catalog shipped with the backend binary.
// The SQL files remain visible in the repository for review and for historical
// migration tests, while production no longer depends on a separately mounted
// migrations directory.
//
//go:embed *.sql baseline/*.sql
var Files embed.FS

//go:generate go run ../cmd/schema-baseline -migrations . -output baseline/030_current.sql
