package migrations

import "embed"

// Files is the versioned migration catalog shipped with the backend binary:
// the numbered chain, released baselines in baseline/, and development
// baselines in compat/, which only KIKOTO_MODE=development reads. Embedding
// compat/ as a directory keeps the build valid when it holds no SQL files.
//
//go:embed *.sql baseline/*.sql compat
var Files embed.FS

//go:generate go run ../cmd/schema-baseline -migrations . -version-file ../../VERSION
