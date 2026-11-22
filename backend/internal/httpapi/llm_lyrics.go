package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/textdecode"
)

type llmLyricsInput struct {
	LocationID int64
	AudioID    int64
	FolderID   int64
	Extension  string
	Hash       string
	Document   llm.LyricsDocument
}

func (s *Server) loadLLMLyrics(ctx context.Context, workID int64, payload llmTranslatePayload, policy llm.Policy) (llmLyricsInput, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result := llmLyricsInput{LocationID: payload.LyricsLocationID, AudioID: payload.AudioMediaItemID}
	if result.LocationID <= 0 || result.AudioID <= 0 {
		return result, llmInvalid("llm_lyrics_selection", "Select one lyrics file and a local audio track.")
	}
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return result, err
	}
	// The translation joins the lyrics of the work folder holding the track.
	track, err := s.loadLocalTrack(ctx, result.AudioID)
	if errors.Is(err, errLocalTrackUnavailable) || err == nil && (!family[track.WorkID] || payload.FolderID > 0 && payload.FolderID != track.FolderID) {
		return result, llmInvalid("llm_lyrics_scope", "Choose a track of this work with an available local file in a work folder.")
	}
	if err != nil {
		return result, err
	}
	result.FolderID = track.FolderID
	if _, err := s.lyricsFetchTarget(ctx, family, result.FolderID); err != nil {
		return result, llmInvalid("llm_lyrics_scope", "The track's work folder is unavailable.")
	}
	var locationWork, sourceID int64
	var kind, locationType, relative, availability, stream, download string
	err = s.db.QueryRowContext(ctx, `SELECT item.work_id,item.kind,location.location_type,location.path,location.availability,COALESCE(location.file_source_id,0),COALESCE(location.stream_url,''),COALESCE(location.download_url,'')
 FROM media_file_location location JOIN media_item item ON item.id=location.media_item_id WHERE location.id=?`, result.LocationID).Scan(&locationWork, &kind, &locationType, &relative, &availability, &sourceID, &stream, &download)
	if err != nil || !family[locationWork] || kind != "text" || availability != "available" && availability != "remote" {
		return result, llmInvalid("llm_lyrics_scope", "The selected lyrics file is outside this work or unavailable.")
	}
	result.Extension = strings.ToLower(filepath.Ext(relative))
	var data []byte
	switch locationType {
	case "remote_stream":
		actor, ok := userFromContext(ctx)
		if !policy.RemoteLyrics || !ok || !userHasPermission(actor, "remote:fetch") {
			return result, llmInvalid("llm_remote_lyrics_disabled", "Remote lyrics translation requires administrator opt-in and remote fetch permission.")
		}
		source, err := s.loadRemotePlaybackSource(ctx, sourceID)
		if err != nil {
			return result, llmInvalid("llm_lyrics_unavailable", "The selected remote lyrics source is unavailable.")
		}
		req, err := http.NewRequestWithContext(ctx, "GET", firstNonEmpty(download, stream), nil)
		if err != nil {
			return result, llmInvalid("llm_lyrics_unavailable", "The selected lyrics file is unavailable.")
		}
		response, err := s.sourceDownloadHTTPClient(source, 30*time.Second).Do(req)
		if err != nil {
			return result, llmInvalid("llm_lyrics_unavailable", "The selected lyrics file could not be read.")
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode < 200 || response.StatusCode >= 300 || response.ContentLength > llm.LyricsLimit {
			return result, llmInvalid("llm_lyrics_unavailable", "The selected lyrics response is unavailable or too large.")
		}
		data, err = io.ReadAll(io.LimitReader(response.Body, llm.LyricsLimit+1))
		if err != nil {
			return result, err
		}
	case "local":
		if err := s.ensureLibraryPathOnline(ctx, relative); err != nil {
			return result, llmInvalid("llm_lyrics_scope", "The lyrics storage pool is offline.")
		}
		root, scopedPath, err := s.openLLMPoolRoot(ctx, relative)
		if err != nil {
			return result, llmInvalid("llm_lyrics_unavailable", "The selected lyrics file is unavailable.")
		}
		defer func() { _ = root.Close() }()
		file, err := root.Open(scopedPath)
		if err != nil {
			return result, llmInvalid("llm_lyrics_unavailable", "The selected lyrics file is unavailable.")
		}
		defer func() { _ = file.Close() }()
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > llm.LyricsLimit {
			return result, llmInvalid("llm_lyrics_unavailable", "The selected lyrics file is unavailable or too large.")
		}
		data, err = io.ReadAll(io.LimitReader(file, llm.LyricsLimit+1))
		if err != nil {
			return result, err
		}
	default:
		return result, llmInvalid("llm_lyrics_scope", "Choose an original local or explicitly enabled remote lyrics file.")
	}
	if len(data) > llm.LyricsLimit {
		return result, llmInvalid("llm_input_too_large", "Lyrics exceed the translation limit.")
	}
	text, err := textdecode.Decode(ctx, data, "")
	if err != nil {
		return result, llmInvalid("llm_lyrics_unavailable", "Lyrics could not be decoded.")
	}
	result.Document, err = llm.ParseLyrics(relative, text)
	if err != nil {
		return result, llmInvalid("llm_lyrics_format", "Lyrics are empty, too large or use an unsupported format.")
	}
	result.Hash = llmValueHash(struct {
		Location, Audio, Folder int64
		Text                    string
	}{result.LocationID, result.AudioID, result.FolderID, text})
	return result, nil
}

// A rooted pool handle rejects symlink escapes into another pool or out of the library.
func (s *Server) openLLMPoolRoot(ctx context.Context, relative string) (*os.Root, string, error) {
	pool, err := s.fetchTransactionPool(ctx, relative)
	if err != nil {
		return nil, "", err
	}
	base := s.cfg.DataRoot
	if pool != "" {
		base, err = safeDataPath(base, pool)
		if err != nil {
			return nil, "", err
		}
	}
	absolute, err := safeDataPath(s.cfg.DataRoot, relative)
	if err != nil {
		return nil, "", err
	}
	scoped, err := filepath.Rel(base, absolute)
	if err != nil || scoped == ".." || strings.HasPrefix(scoped, ".."+string(filepath.Separator)) {
		return nil, "", errors.New("lyrics path escapes its pool")
	}
	root, err := os.OpenRoot(base)
	return root, scoped, err
}
