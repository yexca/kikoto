package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
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
		if err := s.ensureFetchTargetWritable(ctx, relative); err != nil {
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

func saveLLMLyricsAsset(ctx context.Context, tx *sql.Tx, id string, p llmPreview, userID int64) error {
	text, err := p.Lyrics.Document.Render(p.Result.Lyrics)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO llm_lyrics_asset(id,work_id,source_location_id,audio_media_item_id,folder_id,language,source_hash,value_text,extension,created_by_user_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, p.WorkID, p.Lyrics.LocationID, p.Lyrics.AudioID, p.Lyrics.FolderID, p.Target, p.Lyrics.Hash, text, p.Lyrics.Extension, userID)
	return err
}

// The durable database asset precedes filesystem publication. A failed
// publication is completed from the asset without another LLM request. The
// asset joins the target language's lyrics folder of the track's work folder,
// under the track's own path, and is assigned to the track in that language.
func (s *Server) publishLLMLyricsAsset(ctx context.Context, id string) error {
	var workID, audioID, folderID, userID int64
	var language, text, extension, status string
	if err := s.db.QueryRowContext(ctx, "SELECT work_id,audio_media_item_id,folder_id,COALESCE(created_by_user_id,0),language,value_text,extension,status FROM llm_lyrics_asset WHERE id=?", id).Scan(&workID, &audioID, &folderID, &userID, &language, &text, &extension, &status); err != nil {
		return err
	}
	if status == "accepted" {
		return nil
	}
	if status != "publishing" {
		return errors.New("lyrics asset is not publishable")
	}
	track, err := s.loadLocalTrack(ctx, audioID)
	if err != nil {
		return err
	}
	if track.FolderID != folderID {
		return lyricsFetchBadRequest("the audio track moved to another work folder")
	}
	lyricsPath, lyricsID, err := s.publishTrackLyrics(ctx, userID, workID, audioID, folderID, language, track.Path, extension, text, "translation")
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, "UPDATE llm_lyrics_asset SET status='accepted',relative_path=?,media_item_id=? WHERE id=? AND status='publishing'", lyricsPath, nullableInt64(lyricsID), id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return errors.New("lyrics asset was already published")
	}
	return nil
}

func (s *Server) retryLLMLyricsPublication(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	if err := s.publishLLMLyricsAsset(r.Context(), r.PathValue("asset")); err != nil {
		slog.Warn("lyrics translation publication failed", "asset", r.PathValue("asset"), "error", err)
		writeAPIError(w, 409, "llm_asset_pending", "The translation is kept; adding it to the lyrics did not finish. Check the work folder's storage pool and try again.", true)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
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
