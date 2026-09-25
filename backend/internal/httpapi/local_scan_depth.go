package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

const (
	localScanDepthMin = 1
	localScanDepthMax = 8
	// localScanDepthProbeCode renders a Fetch template to count its folder
	// levels. It is a repository-reserved synthetic code.
	localScanDepthProbeCode = "RJ00000000"
)

// requiredLocalScanDepth is the smallest scan depth, counted inside a pool,
// that still reaches every Fetch destination: the work folder level of each
// configured compatible source's save template and every active
// Fetch-managed root already on disk. A shallower scan cannot see those works
// and would otherwise report them missing.
func (s *Server) requiredLocalScanDepth(ctx context.Context) (int, error) {
	return s.requiredLocalScanDepthFor(ctx, "")
}

// requiredLocalScanDepthFor computes the minimum with defaultTemplate as the
// global save template, or the saved one when it is empty.
func (s *Server) requiredLocalScanDepthFor(ctx context.Context, defaultTemplate string) (int, error) {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return 0, err
	}
	if strings.TrimSpace(defaultTemplate) == "" {
		defaultTemplate = s.settingStringContext(ctx, "remote_save_root_template", defaultRemoteSaveRootTemplate)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT code, config_json
		FROM file_source
		WHERE source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
	`)
	if err != nil {
		return 0, err
	}
	type configuredSource struct{ code, configJSON string }
	sources := []configuredSource{}
	for rows.Next() {
		var source configuredSource
		if err := rows.Scan(&source.code, &source.configJSON); err != nil {
			_ = rows.Close()
			return 0, err
		}
		sources = append(sources, source)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	required := localScanDepthMin
	for _, source := range sources {
		var config fileSourceConfig
		_ = json.Unmarshal([]byte(source.configJSON), &config)
		template := strings.TrimSpace(config.SaveRootTemplate)
		if template == "" {
			template = defaultTemplate
		}
		required = max(required, remoteSaveTemplateDepth(template, source.code))
	}
	roots, err := s.db.QueryContext(ctx, `
		SELECT root_path FROM work_folder_location WHERE role = 'managed_fetch' AND state = 'active'
	`)
	if err != nil {
		return 0, err
	}
	defer func() { _ = roots.Close() }()
	for roots.Next() {
		var root string
		if err := roots.Scan(&root); err != nil {
			return 0, err
		}
		_, rest := storagepool.Split(layout.effectiveMode(), root)
		required = max(required, storagepool.Depth(rest))
	}
	return required, roots.Err()
}

// remoteSaveTemplateDepth is the folder level at which template places a work,
// counted from the pool root.
func remoteSaveTemplateDepth(template string, sourceCode string) int {
	return storagepool.Depth(renderRemoteSaveRoot(template, sourceCode, localScanDepthProbeCode))
}

// validateLocalScanDepthSettings rejects a scan depth that would hide Fetched
// works and a save template that places works deeper than any scan reaches.
// It runs before the settings transaction opens, because it reads through the
// connection pool.
func (s *Server) validateLocalScanDepthSettings(ctx context.Context, payload settingsUpdatePayload) error {
	template := ""
	if payload.RemoteSaveTemplate != nil {
		template = strings.TrimSpace(*payload.RemoteSaveTemplate)
		if template == "" {
			template = defaultRemoteSaveRootTemplate
		}
		if remoteSaveTemplateDepth(template, "source") > localScanDepthMax {
			return invalidSettings(fmt.Sprintf("remoteSaveTemplate places works deeper than the maximum scan depth of %d", localScanDepthMax))
		}
	}
	if payload.LocalScanDepth == nil {
		return nil
	}
	required, err := s.requiredLocalScanDepthFor(ctx, template)
	if err != nil {
		return err
	}
	if *payload.LocalScanDepth < required {
		return invalidSettings(fmt.Sprintf("localScanDepth must be at least %d so scans reach the Fetch folders", required))
	}
	return nil
}

// effectiveLocalScanDepth is the configured depth raised to the required
// minimum, so a depth saved before the minimum existed, or set through the
// environment, never hides Fetched works from a scan.
func (s *Server) effectiveLocalScanDepth(ctx context.Context) int {
	configured := s.configuredLocalScanDepth(ctx)
	required, err := s.requiredLocalScanDepth(ctx)
	if err != nil {
		slog.Warn("compute required local scan depth", "error", err)
		return configured
	}
	return max(configured, required)
}
