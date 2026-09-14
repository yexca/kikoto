package httpapi

import (
	"bytes"
	"strings"
)

const transcodeDiagnosticLimit = 16 << 10

// Decoder details belong in protected server logs, never in API errors. Keep
// only a bounded prefix while continuing to drain stderr until the child exits.
type transcodeDiagnosticOutput struct {
	buffer bytes.Buffer
}

func (output *transcodeDiagnosticOutput) Write(value []byte) (int, error) {
	count := len(value)
	remaining := transcodeDiagnosticLimit - output.buffer.Len()
	if remaining > 0 {
		_, _ = output.buffer.Write(value[:min(remaining, count)])
	}
	return count, nil
}

func (output *transcodeDiagnosticOutput) String() string {
	return strings.TrimSpace(output.buffer.String())
}
