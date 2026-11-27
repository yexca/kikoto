package record

import (
	"context"
	"time"
)

// AssetByPath returns the asset recorded at a path relative to the root.
func (s *Store) AssetByPath(ctx context.Context, relative string) (Asset, error) {
	return scanAsset(s.db.QueryRowContext(ctx, `SELECT `+assetColumns+` FROM record_asset a WHERE a.root_id=1 AND a.path_key=?`, pathKey(relative)))
}

// SetLastPlayedAt dates a user's stored progress on an asset, which orders
// Continue watching. A save records the time it is made, to the second, so
// saves made together need their order set this way.
func (s *Store) SetLastPlayedAt(ctx context.Context, userID, assetID int64, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE record_asset_progress SET last_played_at=? WHERE user_id=? AND asset_id=?`, at.UTC().Format(time.DateTime), userID, assetID)
	return err
}
