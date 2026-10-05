package storage

import (
	"database/sql"
	"fmt"
	"io/fs"
)

const metadataBaseline051Checksum = "bc9120ee0dde556df13da2c541baf6bc033069796b7a322950fa85cde432f3eb"

// Two development branches used versions 051 and 052 for different changes.
// Preserve their deployed SQL and ledger entries, and append the missing change
// on each path. Both reach the same schema at 053 and share the root chain after
// that. Only recorded migration identities select the historical path; table
// shape is never used to guess which migrations ran.
func selectMetadataMigrationCatalog(db *sql.DB, migrationFS fs.FS, catalog migrationCatalog) (migrationCatalog, error) {
	if catalog.current < 53 || catalog.byFilename["051_favorite_list_icon.sql"].version != 51 {
		return catalog, nil
	}
	legacy, err := hasMetadataMigrationHistory(db)
	if err != nil || !legacy {
		return catalog, err
	}

	filenames := []string{
		"051_metadata_tag_projection_queue.sql",
		"052_language_scoped_titles.sql",
		"053_favorite_list_icon.sql",
	}
	for index, filename := range filenames {
		version := 51 + index
		asset, err := readMigrationAsset(migrationFS, "compat/metadata/"+filename, version, false)
		if err != nil {
			return migrationCatalog{}, err
		}
		// The on-disk archive path is not the identity stored by old binaries.
		asset.filename = filename
		delete(catalog.byFilename, catalog.migrations[version-1].filename)
		catalog.migrations[version-1] = asset
		catalog.byFilename[filename] = asset
	}
	for _, baseline := range retiredBaselineLedgerAssets {
		if baseline.version == 51 || baseline.version == 52 {
			catalog.byFilename[baseline.filename] = baseline
		}
	}
	return catalog, nil
}

func hasMetadataMigrationHistory(db *sql.DB) (bool, error) {
	rows, err := db.Query(`SELECT filename, checksum FROM schema_migration
		WHERE filename IN ('051_metadata_tag_projection_queue.sql',
			'052_language_scoped_titles.sql', '053_favorite_list_icon.sql',
			'baseline/051_v0.7.1.sql', 'baseline/052_v0.7.1.sql')`)
	if err != nil {
		return false, fmt.Errorf("identify historical metadata migrations: %w", err)
	}
	defer func() { _ = rows.Close() }()
	legacy := false
	for rows.Next() {
		var filename, checksum string
		if err := rows.Scan(&filename, &checksum); err != nil {
			return false, fmt.Errorf("read historical metadata migration: %w", err)
		}
		if filename == "baseline/051_v0.7.1.sql" {
			// Both branches packaged this filename with different schema content.
			// Without a checksum there is no safe way to identify its history.
			if checksum == "" {
				return false, fmt.Errorf("migration %s has no checksum; cannot identify its historical branch", filename)
			}
			legacy = legacy || checksum == metadataBaseline051Checksum
		} else {
			legacy = true
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("read historical metadata migrations: %w", err)
	}
	return legacy, nil
}
