package httpapi

import (
	"context"
	"strings"
)

type mediaLocationFolder struct {
	id           int64
	fileSourceID int64
	root         string
}

// attachLocalLocationFolders names the work folder that holds each local
// location and the location's path below it. A folder holds a location when
// both are on the same file source and the folder's root contains the
// location's path, by the same normalized, case-sensitive rule the scan and
// cleanup use; the deepest such root wins, as it does for the scan.
func (s *Server) attachLocalLocationFolders(ctx context.Context, mediaWorkID int64, mediaItems []mediaItemDetail) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, file_source_id, root_path
		FROM work_folder_location
		WHERE work_id = ?
	`, mediaWorkID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	folders := []mediaLocationFolder{}
	for rows.Next() {
		var folder mediaLocationFolder
		if err := rows.Scan(&folder.id, &folder.fileSourceID, &folder.root); err != nil {
			return err
		}
		if folder.root = normalizeFolderRootPath(folder.root); folder.root != "" {
			folders = append(folders, folder)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(folders) == 0 {
		return nil
	}
	for itemIndex := range mediaItems {
		for locationIndex := range mediaItems[itemIndex].Locations {
			location := &mediaItems[itemIndex].Locations[locationIndex]
			if location.LocationType != "local" {
				continue
			}
			if folder, relative, ok := localLocationFolder(location.FileSourceID, location.Path, folders); ok {
				folderID := folder.id
				location.FolderID = &folderID
				location.RelativePath = relative
			}
		}
	}
	return nil
}

func localLocationFolder(fileSourceID int64, locationPath string, folders []mediaLocationFolder) (mediaLocationFolder, string, bool) {
	normalized := normalizeFolderRootPath(locationPath)
	var matched mediaLocationFolder
	for _, folder := range folders {
		if folder.fileSourceID != fileSourceID || len(folder.root) <= len(matched.root) {
			continue
		}
		if strings.HasPrefix(normalized, folder.root+"/") {
			matched = folder
		}
	}
	if matched.root == "" {
		return mediaLocationFolder{}, "", false
	}
	return matched, strings.TrimPrefix(normalized, matched.root+"/"), true
}
