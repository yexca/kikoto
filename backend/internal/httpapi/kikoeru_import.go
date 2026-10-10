package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/personal"
)

// A Kikoeru account import reads the signed-in user's own reviews and
// playlists from a Kikoeru-compatible server, or from an uploaded Kikoeru
// SQLite database, and returns them as a Kikoto backup. The page then sends
// that backup through the ordinary preview and import flow. Credentials and the
// uploaded database are used for this request only and are never stored.

const (
	kikoeruImportPrivateAddressesSetting = "kikoeru_import_private_addresses"
	kikoeruDatabaseImportPath            = "/api/user-data/kikoeru/database"
	kikoeruAccountImportTimeout          = 3 * time.Minute
	kikoeruAccountRequestTimeout         = 30 * time.Second
	kikoeruDatabaseImportTimeout         = time.Minute
	// kikoeruDatabaseUploadTimeout is how long the database upload may take to
	// arrive. It replaces the server-wide read timeout, which suits small JSON
	// bodies, with a window in which a file up to maxKikoeruDatabaseBytes can
	// be sent over an ordinary home uplink.
	kikoeruDatabaseUploadTimeout       = 15 * time.Minute
	maxKikoeruDatabaseBytes      int64 = 512 << 20
	maxKikoeruImportRequestBytes       = 64 << 10
	maxKikoeruTokenBytes               = 4096
	maxKikoeruNameBytes                = 256
	maxKikoeruPasswordBytes            = 1024
)

// Imports hold outbound connections or a large temporary file; a small fixed
// number may run at once across all accounts.
var kikoeruImportSlots = make(chan struct{}, 2)

var errKikoeruImportRequest = errors.New("invalid kikoeru import request")

var (
	// errKikoeruUploadInvalid is an upload that is not one database file with
	// an account name.
	errKikoeruUploadInvalid = errors.New("invalid kikoeru database upload")
	// errKikoeruUploadInterrupted is an upload whose bytes stopped arriving,
	// through a dropped connection or the upload window closing.
	errKikoeruUploadInterrupted = errors.New("kikoeru database upload was interrupted")
	// errKikoeruDatabaseTimeout is an uploaded database that took too long to read.
	errKikoeruDatabaseTimeout = errors.New("kikoeru database read timed out")
)

type kikoeruImportOptions struct {
	Sources []kikoeruImportSource `json:"sources"`
	// PrivateAddressesAllowed reports whether this account may enter a
	// private or LAN address manually.
	PrivateAddressesAllowed bool `json:"privateAddressesAllowed"`
}

type kikoeruImportSource struct {
	ID          int64  `json:"id"`
	DisplayName string `json:"displayName"`
}

type kikoeruAccountImportRequest struct {
	SourceID *int64 `json:"sourceId"`
	URL      string `json:"url"`
	Auth     struct {
		Mode     string `json:"mode"`
		Token    string `json:"token"`
		Name     string `json:"name"`
		Password string `json:"password"`
	} `json:"auth"`
	AcknowledgedRisk bool                          `json:"acknowledgedRisk"`
	PlaylistNames    personal.KikoeruPlaylistNames `json:"playlistNames"`
}

type kikoeruImportResponse struct {
	Data               personal.Backup         `json:"data"`
	Summary            personal.KikoeruSummary `json:"summary"`
	PlaylistsSupported bool                    `json:"playlistsSupported"`
}

func (s *Server) requireUserDataImport(w http.ResponseWriter, r *http.Request) (currentUser, bool) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return currentUser{}, false
	}
	for _, permission := range []string{"tags:write", "playback:use"} {
		if _, ok = s.requirePermission(w, r, permission); !ok {
			return currentUser{}, false
		}
	}
	return user, true
}

func (s *Server) kikoeruImportPrivateAddressesAllowed(r *http.Request, user currentUser) bool {
	return userHasPermission(user, "sources:write") || s.settingBool(r, kikoeruImportPrivateAddressesSetting, false)
}

func (s *Server) getKikoeruImportOptions(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, display_name
		FROM file_source
		WHERE source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178') AND enabled = 1
		ORDER BY priority, id
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = rows.Close() }()
	options := kikoeruImportOptions{Sources: []kikoeruImportSource{}, PrivateAddressesAllowed: s.kikoeruImportPrivateAddressesAllowed(r, user)}
	for rows.Next() {
		var source kikoeruImportSource
		if err := rows.Scan(&source.ID, &source.DisplayName); err != nil {
			writeError(w, err)
			return
		}
		options.Sources = append(options.Sources, source)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, options)
}

func (s *Server) importKikoeruAccount(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireUserDataImport(w, r)
	if !ok {
		return
	}
	var payload kikoeruAccountImportRequest
	if !decodePersonalBody(w, r, &payload, maxKikoeruImportRequestBytes) {
		return
	}
	if err := normalizeKikoeruAccountRequest(&payload); err != nil {
		writeKikoeruImportError(w, err)
		return
	}
	manual := payload.SourceID == nil
	if (manual || payload.Auth.Mode != "none") && !payload.AcknowledgedRisk {
		writeAPIError(w, http.StatusBadRequest, "kikoeru_risk_not_acknowledged", "Confirm the risk notice before connecting.", false)
		return
	}
	baseURL, allowPrivate, err := s.kikoeruAccountDestination(r, user, payload)
	if err != nil {
		writeKikoeruImportError(w, err)
		return
	}
	policy, err := outbound.NewPolicy([]outbound.Destination{{URL: baseURL, AllowPrivate: allowPrivate}}, outbound.Options{})
	if err != nil {
		writeKikoeruImportError(w, err)
		return
	}
	if !acquireKikoeruImportSlot(w) {
		return
	}
	defer releaseKikoeruImportSlot()

	ctx, cancel := context.WithTimeout(r.Context(), kikoeruAccountImportTimeout)
	defer cancel()
	// The transport is private to this import; drop its connections when done.
	httpClient := policy.Client(nil, kikoeruAccountRequestTimeout)
	defer httpClient.CloseIdleConnections()
	client := kikoeru.NewAccountClient(baseURL, httpClient)
	response, err := readKikoeruAccount(ctx, client, payload)
	if err != nil {
		slog.Warn("kikoeru account import failed", "manual_url", manual, "error", err)
		writeKikoeruImportError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, response)
}

func normalizeKikoeruAccountRequest(payload *kikoeruAccountImportRequest) error {
	payload.URL = strings.TrimSpace(payload.URL)
	if (payload.SourceID == nil) == (payload.URL == "") {
		return errKikoeruImportRequest
	}
	auth := &payload.Auth
	switch auth.Mode {
	case "none":
		auth.Token, auth.Name, auth.Password = "", "", ""
	case "token":
		auth.Token = strings.TrimSpace(auth.Token)
		if len(auth.Token) > 7 && strings.EqualFold(auth.Token[:7], "bearer ") {
			auth.Token = strings.TrimSpace(auth.Token[7:])
		}
		if auth.Token == "" || len(auth.Token) > maxKikoeruTokenBytes || strings.IndexFunc(auth.Token, func(r rune) bool { return r <= ' ' || r > '~' }) >= 0 {
			return errKikoeruImportRequest
		}
	case "password":
		auth.Name = strings.TrimSpace(auth.Name)
		if auth.Name == "" || len(auth.Name) > maxKikoeruNameBytes || strings.IndexFunc(auth.Name, unicode.IsControl) >= 0 ||
			auth.Password == "" || len(auth.Password) > maxKikoeruPasswordBytes {
			return errKikoeruImportRequest
		}
	default:
		return errKikoeruImportRequest
	}
	return nil
}

// kikoeruAccountDestination resolves the API base the import may reach. A
// configured source keeps its administrator-trusted endpoint; a manual URL may
// reach a private address only when this account is allowed to.
func (s *Server) kikoeruAccountDestination(r *http.Request, user currentUser, payload kikoeruAccountImportRequest) (string, bool, error) {
	if payload.SourceID != nil {
		source, err := s.loadRemoteSourceForUse(r.Context(), *payload.SourceID)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && (!isKikoeruSourceType(source.SourceType) || !source.Enabled)) {
			return "", false, errKikoeruSourceNotFound
		}
		if err != nil {
			return "", false, err
		}
		return strings.TrimRight(strings.TrimSpace(source.Endpoint.APIURL), "/"), true, nil
	}
	parsed, err := outbound.ParseHTTPURL(payload.URL)
	if err != nil {
		return "", false, errKikoeruImportRequest
	}
	if parsed.RawQuery != "" || parsed.ForceQuery {
		return "", false, errKikoeruImportRequest
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed.String(), s.kikoeruImportPrivateAddressesAllowed(r, user), nil
}

var errKikoeruSourceNotFound = errors.New("kikoeru import source not found")

func readKikoeruAccount(ctx context.Context, client *kikoeru.AccountClient, payload kikoeruAccountImportRequest) (kikoeruImportResponse, error) {
	switch payload.Auth.Mode {
	case "password":
		if err := client.Login(ctx, payload.Auth.Name, payload.Auth.Password); err != nil {
			return kikoeruImportResponse{}, err
		}
	case "token":
		client.WithToken(payload.Auth.Token)
	}
	reviews, err := client.Reviews(ctx, personal.MaxKikoeruWorks)
	if err != nil {
		return kikoeruImportResponse{}, err
	}
	var playlists []personal.KikoeruPlaylist
	supported := true
	accountPlaylists, err := client.Playlists(ctx)
	switch {
	case errors.Is(err, kikoeru.ErrAccountUnsupported):
		supported = false
	case err != nil:
		return kikoeruImportResponse{}, err
	}
	remaining := personal.MaxKikoeruPlaylistItems
	for _, playlist := range accountPlaylists {
		works, err := client.PlaylistWorks(ctx, playlist.ID, remaining)
		if err != nil {
			return kikoeruImportResponse{}, err
		}
		remaining -= len(works)
		codes := make([]string, 0, len(works))
		for _, work := range works {
			codes = append(codes, personal.KikoeruWorkCode("", work.SourceID, work.ID))
		}
		playlists = append(playlists, personal.KikoeruPlaylist{Name: playlist.Name, Description: playlist.Description, System: playlist.System, Codes: codes})
	}
	response, err := kikoeruImportResult(reviews, playlists, payload.PlaylistNames)
	response.PlaylistsSupported = supported
	return response, err
}

func kikoeruImportResult(reviews []kikoeru.AccountReview, playlists []personal.KikoeruPlaylist, names personal.KikoeruPlaylistNames) (kikoeruImportResponse, error) {
	converted := make([]personal.KikoeruReview, 0, len(reviews))
	for _, review := range reviews {
		converted = append(converted, personal.KikoeruReview{
			Code:       personal.KikoeruWorkCode("", review.SourceID, review.WorkID, review.ID),
			Progress:   review.Progress,
			Rating:     review.Rating,
			ReviewText: review.ReviewText,
		})
	}
	backup, summary, err := personal.KikoeruAccountBackup(converted, playlists, names)
	if err != nil {
		return kikoeruImportResponse{}, err
	}
	return kikoeruImportResponse{Data: backup, Summary: summary}, nil
}

func (s *Server) importKikoeruDatabase(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireUserDataImport(w, r); !ok {
		return
	}
	// Taking a slot before receiving bounds the temporary disk use as well.
	if !acquireKikoeruImportSlot(w) {
		return
	}
	defer releaseKikoeruImportSlot()
	if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(kikoeruDatabaseUploadTimeout)); err != nil {
		slog.Warn("kikoeru database upload keeps the server read timeout", "error", err)
	}
	file, err := os.CreateTemp(s.cfg.TempDir, "kikoto-kikoeru-*.sqlite3")
	if err != nil {
		writeError(w, err)
		return
	}
	// The upload holds every account's data; it never outlives this request.
	defer func() {
		_ = file.Close()
		_ = os.Remove(file.Name())
	}()
	userName, acknowledged, err := receiveKikoeruDatabase(r, file)
	if err != nil {
		writeKikoeruImportError(w, err)
		return
	}
	if !acknowledged {
		writeAPIError(w, http.StatusBadRequest, "kikoeru_risk_not_acknowledged", "Confirm the risk notice before uploading.", false)
		return
	}
	if err := file.Close(); err != nil {
		writeError(w, err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), kikoeruDatabaseImportTimeout)
	defer cancel()
	reviews, err := kikoeru.ReadDatabaseReviews(ctx, file.Name(), userName, personal.MaxKikoeruWorks)
	if err != nil {
		if !errors.Is(err, kikoeru.ErrDatabaseUserNotFound) {
			slog.Warn("kikoeru database import failed", "error", err)
		}
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = errKikoeruDatabaseTimeout
		}
		writeKikoeruImportError(w, err)
		return
	}
	response, err := kikoeruImportResult(reviews, nil, personal.KikoeruPlaylistNames{})
	if err != nil {
		writeKikoeruImportError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, response)
}

// receiveKikoeruDatabase streams the multipart upload into file. It accepts a
// userName field, an acknowledgedRisk field, and one database file part.
func receiveKikoeruDatabase(r *http.Request, file *os.File) (string, bool, error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return "", false, errKikoeruUploadInvalid
	}
	var userName string
	var acknowledged, received bool
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", false, uploadError(err)
		}
		switch part.FormName() {
		case "userName":
			userName, err = readMultipartField(part, maxKikoeruNameBytes)
		case "acknowledgedRisk":
			var value string
			value, err = readMultipartField(part, 8)
			acknowledged = value == "true"
		case "file":
			if received {
				err = errKikoeruUploadInvalid
				break
			}
			received = true
			var written int64
			written, err = io.Copy(file, io.LimitReader(part, maxKikoeruDatabaseBytes+1))
			if err == nil && written > maxKikoeruDatabaseBytes {
				err = personal.ErrLimit
			}
		default:
			err = errKikoeruUploadInvalid
		}
		_ = part.Close()
		if err != nil {
			return "", false, uploadError(err)
		}
	}
	userName = strings.TrimSpace(userName)
	if !received || userName == "" || strings.IndexFunc(userName, unicode.IsControl) >= 0 {
		return "", false, errKikoeruUploadInvalid
	}
	return userName, acknowledged, nil
}

func readMultipartField(part *multipart.Part, limit int) (string, error) {
	data, err := io.ReadAll(io.LimitReader(part, int64(limit)+1))
	if err != nil {
		return "", err
	}
	if len(data) > limit {
		return "", errKikoeruUploadInvalid
	}
	return string(data), nil
}

func uploadError(err error) error {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) || errors.Is(err, personal.ErrLimit) {
		return personal.ErrLimit
	}
	if errors.Is(err, errKikoeruUploadInvalid) {
		return err
	}
	// What is left is the transport: the body ended early, the connection
	// dropped, or the upload window closed. None of it is about the form.
	return errors.Join(errKikoeruUploadInterrupted, err)
}

func acquireKikoeruImportSlot(w http.ResponseWriter) bool {
	select {
	case kikoeruImportSlots <- struct{}{}:
		return true
	default:
		writeAPIError(w, http.StatusTooManyRequests, "kikoeru_import_busy", "Another import is running. Try again shortly.", true)
		return false
	}
}

func releaseKikoeruImportSlot() {
	<-kikoeruImportSlots
}

// writeKikoeruImportError reports a sanitized failure class. Upstream status
// text, endpoints, and local paths stay in the protected log.
func writeKikoeruImportError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errKikoeruImportRequest):
		writeAPIError(w, http.StatusBadRequest, "kikoeru_invalid_request", "Check the address and sign-in details.", false)
	case errors.Is(err, errKikoeruUploadInvalid):
		writeAPIError(w, http.StatusBadRequest, "kikoeru_upload_invalid", "The upload must contain one database file and an account name.", false)
	case errors.Is(err, errKikoeruUploadInterrupted):
		writeAPIError(w, http.StatusRequestTimeout, "kikoeru_upload_interrupted", "The upload did not finish. Check the connection and try again.", true)
	case errors.Is(err, errKikoeruDatabaseTimeout):
		writeAPIError(w, http.StatusServiceUnavailable, "kikoeru_database_timeout", "Reading the database took too long. Try again.", true)
	case errors.Is(err, errKikoeruSourceNotFound):
		writeAPIError(w, http.StatusNotFound, "kikoeru_source_not_found", "The selected source is not available.", false)
	case errors.Is(err, personal.ErrLimit), errors.Is(err, kikoeru.ErrAccountLimit):
		writePersonalError(w, personal.ErrLimit)
	case errors.Is(err, kikoeru.ErrAccountUnauthorized):
		// Not 401: that status means this Kikoto session expired.
		writeAPIError(w, http.StatusUnprocessableEntity, "kikoeru_unauthorized", "The Kikoeru server rejected the sign-in.", false)
	case errors.Is(err, outbound.ErrPolicyViolation):
		writeAPIError(w, http.StatusForbidden, "kikoeru_destination_not_allowed", "This address is not allowed.", false)
	case errors.Is(err, kikoeru.ErrDatabaseUserNotFound):
		writeAPIError(w, http.StatusNotFound, "kikoeru_user_not_found", "The database has no account with that name.", false)
	case errors.Is(err, kikoeru.ErrDatabaseInvalid):
		writeAPIError(w, http.StatusBadRequest, "kikoeru_database_invalid", "The file is not a readable Kikoeru database.", false)
	case errors.Is(err, kikoeru.ErrAccountUnsupported), errors.Is(err, kikoeru.ErrAccountResponse):
		writeAPIError(w, http.StatusBadGateway, "kikoeru_unsupported", "The server did not answer like a Kikoeru API.", false)
	case errors.Is(err, context.DeadlineExceeded):
		writeAPIError(w, http.StatusGatewayTimeout, "kikoeru_timeout", "The Kikoeru server took too long to answer.", true)
	case errors.Is(err, personal.ErrInvalid):
		writePersonalError(w, err)
	default:
		writeAPIError(w, http.StatusBadGateway, "kikoeru_unavailable", "The Kikoeru server could not be reached.", true)
	}
}
