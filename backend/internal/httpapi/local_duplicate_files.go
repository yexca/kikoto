package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"sort"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

// duplicateFileHashBudget bounds how long one request spends hashing. A
// request that runs out reports what is still pending, and the next request
// continues from the hashes this one stored.
const duplicateFileHashBudget = 20 * time.Second

type duplicateFilesResponse struct {
	// Complete is false while files that could be identical are still unhashed.
	Complete     bool                 `json:"complete"`
	CheckedFiles int                  `json:"checkedFiles"`
	PendingFiles int                  `json:"pendingFiles"`
	PendingBytes int64                `json:"pendingBytes"`
	Groups       []duplicateFileGroup `json:"groups"`
}

// duplicateFileGroup is a set of local files that hold the same bytes.
type duplicateFileGroup struct {
	SizeBytes int64           `json:"sizeBytes"`
	Files     []duplicateFile `json:"files"`
}

type duplicateFile struct {
	LocationID  int64  `json:"locationId"`
	MediaItemID int64  `json:"mediaItemId"`
	WorkID      int64  `json:"workId"`
	WorkCode    string `json:"workCode"`
	Path        string `json:"path"`
}

// duplicateFileCandidate is one available local file with its current
// observation and the hash cached for it.
type duplicateFileCandidate struct {
	duplicateFile
	absolute string
	size     int64
	version  string
	hash     string
}

// findWorkDuplicateFiles reports the local files of a work's family that hold
// the same bytes, in any of its editions and folders. Only files that share a
// size are hashed, and hashes are cached per file version, so repeating the
// request is cheap. It never changes a library file.
func (s *Server) findWorkDuplicateFiles(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	response, err := s.duplicateFilesForWork(r.Context(), workID, duplicateFileHashBudget)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) duplicateFilesForWork(ctx context.Context, workID int64, budget time.Duration) (duplicateFilesResponse, error) {
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return duplicateFilesResponse{}, err
	}
	// An edition nobody has opened yet has no indexed files to compare.
	for familyWorkID := range family {
		if err := s.ensureLocalMediaIndexed(ctx, familyWorkID); err != nil {
			return duplicateFilesResponse{}, err
		}
	}
	candidates, err := s.loadDuplicateFileCandidates(ctx, family)
	if err != nil {
		return duplicateFilesResponse{}, err
	}
	// A file can only equal a file of its own size, so sizes rule most out
	// before any byte is read.
	bySize := map[int64][]*duplicateFileCandidate{}
	for index := range candidates {
		candidate := &candidates[index]
		bySize[candidate.size] = append(bySize[candidate.size], candidate)
	}
	pending := []*duplicateFileCandidate{}
	comparable := []*duplicateFileCandidate{}
	for size, group := range bySize {
		if size == 0 || len(group) < 2 {
			continue
		}
		for _, candidate := range group {
			comparable = append(comparable, candidate)
			if candidate.hash == "" {
				pending = append(pending, candidate)
			}
		}
	}
	// Small files first, so the first response already reports most groups.
	sort.Slice(pending, func(i, j int) bool {
		if pending[i].size != pending[j].size {
			return pending[i].size < pending[j].size
		}
		return pending[i].LocationID < pending[j].LocationID
	})
	deadline := time.Now().Add(budget)
	for index, candidate := range pending {
		// Always hash one file, so every request makes progress.
		if index > 0 && !time.Now().Before(deadline) {
			break
		}
		if err := s.hashDuplicateFileCandidate(ctx, candidate); err != nil {
			return duplicateFilesResponse{}, err
		}
	}

	response := duplicateFilesResponse{Groups: []duplicateFileGroup{}}
	type contentKey struct {
		size int64
		hash string
	}
	byContent := map[contentKey][]duplicateFile{}
	for _, candidate := range comparable {
		switch candidate.hash {
		case "":
			response.PendingFiles++
			response.PendingBytes += candidate.size
		case unreadableDuplicateFileHash:
			// The file changed or could not be read; it is not compared.
		default:
			response.CheckedFiles++
			key := contentKey{size: candidate.size, hash: candidate.hash}
			byContent[key] = append(byContent[key], candidate.duplicateFile)
		}
	}
	for key, files := range byContent {
		if len(files) < 2 {
			continue
		}
		sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
		response.Groups = append(response.Groups, duplicateFileGroup{SizeBytes: key.size, Files: files})
	}
	sort.Slice(response.Groups, func(i, j int) bool {
		return response.Groups[i].Files[0].Path < response.Groups[j].Files[0].Path
	})
	response.Complete = response.PendingFiles == 0
	return response, nil
}

// unreadableDuplicateFileHash marks a candidate whose content could not be
// established during this request. It is never stored.
const unreadableDuplicateFileHash = "-"

func (s *Server) loadDuplicateFileCandidates(ctx context.Context, family map[int64]bool) ([]duplicateFileCandidate, error) {
	workIDs := make([]int64, 0, len(family))
	for workID := range family {
		workIDs = append(workIDs, workID)
	}
	query, args := int64InQuery("item.work_id IN (%s)", workIDs)
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, item.id, item.work_id, work.primary_code, location.path,
			location.content_hash, location.content_hash_version
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		WHERE `+query+`
			AND location.location_type = 'local'
			AND location.availability = 'available'
		ORDER BY location.id
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	type storedCandidate struct {
		file              duplicateFile
		hash, hashVersion string
	}
	stored := []storedCandidate{}
	for rows.Next() {
		var candidate storedCandidate
		if err := rows.Scan(
			&candidate.file.LocationID, &candidate.file.MediaItemID, &candidate.file.WorkID,
			&candidate.file.WorkCode, &candidate.file.Path, &candidate.hash, &candidate.hashVersion,
		); err != nil {
			return nil, err
		}
		stored = append(stored, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	// The files are inspected after the cursor is closed, so a slow disk does
	// not hold a pooled connection.
	availability, err := s.loadLibraryAvailability(ctx)
	if err != nil {
		return nil, err
	}
	candidates := make([]duplicateFileCandidate, 0, len(stored))
	for _, entry := range stored {
		if !availability.readable(entry.file.Path) {
			continue
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, entry.file.Path)
		if err != nil {
			continue
		}
		info, err := os.Lstat(absolute)
		// A link is not this folder's own copy of the bytes, and a file on an
		// offline pool is not compared.
		if err != nil || !info.Mode().IsRegular() || unsafeFetchStagingEntry(info) {
			continue
		}
		candidate := duplicateFileCandidate{
			duplicateFile: entry.file, absolute: absolute,
			size: info.Size(), version: localfs.FileVersion(info),
		}
		if entry.hash != "" && entry.hashVersion == candidate.version {
			candidate.hash = entry.hash
		}
		candidates = append(candidates, candidate)
	}
	return candidates, nil
}

// hashDuplicateFileCandidate hashes one file and caches the result for the
// version it read. A file that changes while it is read is left out of this
// response instead of being reported with a hash of mixed content.
func (s *Server) hashDuplicateFileCandidate(ctx context.Context, candidate *duplicateFileCandidate) error {
	hash, err := hashFileContext(ctx, candidate.absolute)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		candidate.hash = unreadableDuplicateFileHash
		return nil
	}
	info, err := os.Lstat(candidate.absolute)
	if err != nil || localfs.FileVersion(info) != candidate.version {
		candidate.hash = unreadableDuplicateFileHash
		return nil
	}
	candidate.hash = hash
	_, err = s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET content_hash = ?, content_hash_version = ?
		WHERE id = ?
	`, hash, candidate.version, candidate.LocationID)
	return err
}

// hashFileContext is the SHA-256 of a file, stopping when ctx is cancelled.
func hashFileContext(ctx context.Context, path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	buffer := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		read, err := file.Read(buffer)
		if read > 0 {
			_, _ = hash.Write(buffer[:read])
		}
		if errors.Is(err, io.EOF) {
			return hex.EncodeToString(hash.Sum(nil)), nil
		}
		if err != nil {
			return "", err
		}
	}
}
