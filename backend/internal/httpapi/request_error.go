package httpapi

import (
	"database/sql"
	"errors"
	"net/http"
)

// requestError is a failure the caller caused: the thing it addressed does not
// exist, or is not of a kind or in a state the operation applies to. It is
// never a server or upstream fault, so it is answered with its own 4xx status,
// is not retryable, and is not logged as an error.
//
// The message is returned to the client; it must not carry a local path, a
// private endpoint, or upstream detail.
type requestError struct {
	status  int
	code    string
	message string
	cause   error
}

func (err *requestError) Error() string { return err.message }

func (err *requestError) Unwrap() error { return err.cause }

func notFoundError(message string) error {
	return &requestError{status: http.StatusNotFound, code: "not_found", message: message}
}

func invalidRequestError(message string) error {
	return &requestError{status: http.StatusBadRequest, code: "invalid_request", message: message}
}

func conflictError(message string) error {
	return &requestError{status: http.StatusConflict, code: "conflict", message: message}
}

// rejectedRequestError refuses a well-formed request that cannot be carried out
// as asked, under a code the client can explain. cause stays reachable through
// errors.Is and errors.As for callers that act on the underlying condition.
func rejectedRequestError(code string, message string, cause error) error {
	return &requestError{status: http.StatusUnprocessableEntity, code: code, message: message, cause: cause}
}

var (
	errRemoteSourceNotFound = notFoundError("remote source not found")
	// A source that exists but cannot serve the operation: it is disabled, or
	// its type has no compatible API.
	errRemoteSourceNotUsable error = &requestError{
		status: http.StatusConflict, code: "source_not_usable",
		message: "remote source is disabled or does not support this operation",
	}
	// The source answered that it has no such work. It wraps sql.ErrNoRows so
	// callers that already treat a missing row as "not found" keep doing so,
	// and so the answer never counts against the source's health.
	errRemoteWorkNotFound error = &requestError{
		status: http.StatusNotFound, code: "not_found",
		message: "work was not found on the remote source", cause: sql.ErrNoRows,
	}
)

// writeRequestError answers a requestError and reports whether it did.
func writeRequestError(w http.ResponseWriter, err error) bool {
	var requestErr *requestError
	if !errors.As(err, &requestErr) {
		return false
	}
	writeAPIError(w, requestErr.status, requestErr.code, requestErr.message, false)
	return true
}
