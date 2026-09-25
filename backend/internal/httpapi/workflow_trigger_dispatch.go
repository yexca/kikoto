package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
	"unicode"
)

const (
	minimumWorkflowIntervalMinutes = 5
	maximumWorkflowIntervalMinutes = 7 * 24 * 60
)

type workflowIntervalSchedule struct {
	IntervalMinutes int `json:"intervalMinutes"`
}

type preparedWorkflowTrigger struct {
	NextRunAt  any
	ConfigJSON string
}

type workflowRunTrigger struct {
	Type   string
	Reason string
	ID     int64
}

type systemWorkflowTriggerConfig struct {
	UserID          int64  `json:"userId,omitempty"`
	SourceID        int64  `json:"sourceId,omitempty"`
	Action          string `json:"action,omitempty"`
	Limit           int    `json:"limit,omitempty"`
	Period          string `json:"period,omitempty"`
	ReleaseWindow   string `json:"releaseWindow,omitempty"`
	Year            int    `json:"year,omitempty"`
	TagNameTemplate string `json:"tagNameTemplate,omitempty"`
	SkipTag         bool   `json:"skipTag,omitempty"`
}

type localScanTriggerConfig struct {
	FollowUpRun bool   `json:"followUpRun"`
	ScanMode    string `json:"scanMode,omitempty"`
}

var workflowTagTemplateTokenPattern = regexp.MustCompile(`\{[a-z_]+\}`)

func (s *Server) prepareWorkflowTrigger(ctx context.Context, actor currentUser, definition workflowDefinitionRecord, payload workflowTriggerPayload, now time.Time, existing *workflowTriggerRecord) (preparedWorkflowTrigger, error) {
	if definition.Scope != "system" || !systemWorkflowSupportsConfigurableTriggers(definition.Code) {
		return preparedWorkflowTrigger{}, fmt.Errorf("this workflow does not support configurable triggers")
	}
	prepared, err := prepareSystemWorkflowTriggerTiming(definition, payload, now, existing)
	if err != nil {
		return preparedWorkflowTrigger{}, err
	}
	prepared, requiredPermissions, err := s.normalizeSystemWorkflowTriggerConfig(ctx, actor, definition, payload, existing, now, prepared)
	if err != nil {
		return preparedWorkflowTrigger{}, err
	}
	if missing := missingWorkflowGraphPermission(actor.Permissions, requiredPermissions); missing != "" {
		return preparedWorkflowTrigger{}, fmt.Errorf("automated workflow requires permission %s", missing)
	}
	return prepared, nil
}

func prepareSystemWorkflowTriggerTiming(definition workflowDefinitionRecord, payload workflowTriggerPayload, now time.Time, existing *workflowTriggerRecord) (preparedWorkflowTrigger, error) {
	prepared := preparedWorkflowTrigger{ConfigJSON: "{}"}
	if definition.Code == "availability_watch" && payload.TriggerType != "schedule" {
		return preparedWorkflowTrigger{}, fmt.Errorf("%s supports one interval schedule only", availabilityWatchDisplayName)
	}
	if definition.Code == "metadata_sync" && payload.TriggerType != "schedule" {
		return preparedWorkflowTrigger{}, fmt.Errorf("metadata sync supports interval schedules only")
	}
	switch payload.TriggerType {
	case "startup":
	case "schedule":
		schedule, err := validateWorkflowIntervalSchedule(payload.ScheduleJSON)
		if err != nil {
			return preparedWorkflowTrigger{}, err
		}
		if payload.Enabled != nil && !*payload.Enabled {
			break
		}
		prepared.NextRunAt = formatWorkflowTimestamp(now.Add(time.Duration(schedule.IntervalMinutes) * time.Minute))
	case "filesystem_event":
		if definition.Code != "local_library_scan" || existing == nil || existing.TriggerType != "filesystem_event" {
			return preparedWorkflowTrigger{}, fmt.Errorf("filesystem watching is a fixed trigger for the local library scan")
		}
	default:
		return preparedWorkflowTrigger{}, fmt.Errorf("unsupported built-in workflow trigger")
	}
	return prepared, nil
}

func (s *Server) normalizeSystemWorkflowTriggerConfig(
	ctx context.Context,
	actor currentUser,
	definition workflowDefinitionRecord,
	payload workflowTriggerPayload,
	existing *workflowTriggerRecord,
	now time.Time,
	prepared preparedWorkflowTrigger,
) (preparedWorkflowTrigger, []string, error) {
	requiredPermissions := []string{"workflows:run"}
	switch definition.Code {
	case "availability_watch":
		config := systemWorkflowTriggerConfig{UserID: workflowTriggerOwnerID(actor, existing)}
		action, err := s.availabilityWatchConfiguredAction(ctx)
		if err != nil {
			return preparedWorkflowTrigger{}, nil, err
		}
		if availabilityWatchActionRequiresDownloads(action) {
			requiredPermissions = append(requiredPermissions, "downloads:manage")
		}
		prepared.ConfigJSON = mustJSON(config)
	case "local_library_scan":
		config, err := normalizeLocalScanTriggerConfig(payload.ConfigJSON)
		if err != nil {
			return preparedWorkflowTrigger{}, nil, err
		}
		if payload.TriggerType == "filesystem_event" {
			config.FollowUpRun = false
		} else {
			config.ScanMode = localScanModeFull
		}
		prepared.ConfigJSON = mustJSON(config)
		requiredPermissions = append(requiredPermissions, "metadata:sync")
	case localMediaIndexWorkflowCode:
		config, err := normalizeLocalMediaIndexTriggerConfig(payload.ConfigJSON)
		if err != nil {
			return preparedWorkflowTrigger{}, nil, err
		}
		prepared.ConfigJSON = mustJSON(config)
		requiredPermissions = append(requiredPermissions, "metadata:sync")
	case "metadata_sync":
		var options metadataSyncOptions
		if strings.TrimSpace(payload.ConfigJSON) != "" {
			if err := decodeStrictJSON(payload.ConfigJSON, &options); err != nil {
				return preparedWorkflowTrigger{}, nil, fmt.Errorf("config JSON must contain the metadata sync scope")
			}
		}
		options, err := s.validateMetadataSyncOptions(ctx, options)
		if err != nil {
			return preparedWorkflowTrigger{}, nil, err
		}
		requiredPermissions = append(requiredPermissions, "metadata:sync")
		prepared.ConfigJSON = mustJSON(options)
	case "remote_popular_collection":
		config, err := s.normalizeRemotePopularTriggerConfig(ctx, actor, payload.ConfigJSON, existing, now)
		if err != nil {
			return preparedWorkflowTrigger{}, nil, err
		}
		requiredPermissions = append(requiredPermissions, "tags:write")
		prepared.ConfigJSON = mustJSON(config)
	case "dlsite_popular_collection":
		config, err := normalizeDLsitePopularTriggerConfig(actor, payload.ConfigJSON, existing, now)
		if err != nil {
			return preparedWorkflowTrigger{}, nil, err
		}
		requiredPermissions = append(requiredPermissions, "metadata:sync", "tags:write")
		prepared.ConfigJSON = mustJSON(config)
	default:
		spec, found := presetWorkflowSpecByCode(definition.Code)
		if !found {
			break
		}
		config, permissions, err := s.normalizePresetWorkflowTriggerConfig(ctx, actor, spec, payload.ConfigJSON, existing, now)
		if err != nil {
			return preparedWorkflowTrigger{}, nil, err
		}
		requiredPermissions = append(requiredPermissions, permissions...)
		prepared.ConfigJSON = mustJSON(config)
	}
	return prepared, requiredPermissions, nil
}

func normalizeLocalScanTriggerConfig(raw string) (localScanTriggerConfig, error) {
	config := localScanTriggerConfig{ScanMode: localScanModeIncremental}
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	if err := decodeStrictJSON(raw, &config); err != nil {
		return config, fmt.Errorf("local scan trigger config is invalid")
	}
	config.ScanMode = strings.ToLower(strings.TrimSpace(config.ScanMode))
	if config.ScanMode == "" {
		config.ScanMode = localScanModeIncremental
	}
	if config.ScanMode != localScanModeIncremental && config.ScanMode != localScanModeFull {
		return config, fmt.Errorf("local scan trigger mode must be incremental or full")
	}
	return config, nil
}

func systemWorkflowSupportsConfigurableTriggers(code string) bool {
	switch code {
	case "availability_watch", "local_library_scan", localMediaIndexWorkflowCode, "metadata_sync", "remote_popular_collection", "dlsite_popular_collection":
		return true
	default:
		return isPresetWorkflowCode(code)
	}
}

// scheduledSystemWorkflowCodes lists the system definitions whose interval
// triggers the coordinator dispatches.
func scheduledSystemWorkflowCodes() []string {
	return append([]string{
		"availability_watch", "local_library_scan", localMediaIndexWorkflowCode, "metadata_sync",
		"remote_popular_collection", "dlsite_popular_collection",
	}, presetWorkflowCodes()...)
}

func stringArgs(values []string) []any {
	args := make([]any, 0, len(values))
	for _, value := range values {
		args = append(args, value)
	}
	return args
}

func (s *Server) ensureAvailabilityWatchSchedule(ctx context.Context, definition workflowDefinitionRecord, excludeID int64, triggerType string) error {
	if definition.Code != "availability_watch" {
		return nil
	}
	if triggerType != "schedule" {
		return fmt.Errorf("%s supports one interval schedule only", availabilityWatchDisplayName)
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM workflow_trigger
		WHERE workflow_definition_id = ? AND trigger_type = 'schedule' AND id <> ?
	`, definition.ID, excludeID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return fmt.Errorf("%s already has a schedule", availabilityWatchDisplayName)
	}
	return nil
}

func (s *Server) availabilityWatchConfiguredAction(ctx context.Context) (string, error) {
	var action string
	err := s.db.QueryRowContext(ctx, "SELECT action FROM availability_watch WHERE id = ?", availabilityWatchID).Scan(&action)
	if errors.Is(err, sql.ErrNoRows) {
		return "monitor", nil
	}
	return action, err
}

func workflowTriggerOwnerID(actor currentUser, existing *workflowTriggerRecord) int64 {
	if existing == nil {
		return actor.ID
	}
	var config systemWorkflowTriggerConfig
	if json.Unmarshal([]byte(existing.ConfigJSON), &config) == nil && config.UserID > 0 {
		return config.UserID
	}
	return actor.ID
}

func (s *Server) normalizeRemotePopularTriggerConfig(ctx context.Context, actor currentUser, raw string, existing *workflowTriggerRecord, now time.Time) (systemWorkflowTriggerConfig, error) {
	config := systemWorkflowTriggerConfig{}
	if err := decodeStrictJSON(raw, &config); err != nil {
		return config, fmt.Errorf("remote popular trigger config is invalid")
	}
	config.UserID = workflowTriggerOwnerID(actor, existing)
	config.Action = normalizeRemoteCollectionAction(config.Action)
	if config.SourceID <= 0 {
		return config, fmt.Errorf("sourceId is required")
	}
	if config.Action == "" {
		return config, fmt.Errorf("action must be track or fetch")
	}
	if config.Action == "fetch" {
		return config, fmt.Errorf("automated remote popular collection supports track only")
	}
	if config.Limit <= 0 || config.Limit > 100 {
		return config, fmt.Errorf("limit must be between 1 and 100")
	}
	source, err := s.remoteCollectionSource(ctx, config.SourceID)
	if err != nil {
		return config, err
	}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		return config, fmt.Errorf("source is not an enabled compatible remote source")
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return config, fmt.Errorf("source has no API endpoint")
	}
	if strings.TrimSpace(config.TagNameTemplate) == "" && !config.SkipTag {
		config.TagNameTemplate = "{date}_{remote_name}_popular"
	}
	if !config.SkipTag {
		_, err = renderWorkflowTagNameTemplate(config.TagNameTemplate, map[string]string{
			"date": now.UTC().Format("060102"), "remote_name": workflowTagFragment(source.DisplayName),
			"source_code": workflowTagFragment(source.Code), "action": config.Action,
		})
	}
	return config, err
}

func normalizeDLsitePopularTriggerConfig(actor currentUser, raw string, existing *workflowTriggerRecord, now time.Time) (systemWorkflowTriggerConfig, error) {
	config := systemWorkflowTriggerConfig{}
	if err := decodeStrictJSON(raw, &config); err != nil {
		return config, fmt.Errorf("DLsite popular trigger config is invalid")
	}
	config.UserID = workflowTriggerOwnerID(actor, existing)
	normalized, err := normalizeDLsitePopularRequest(dlsitePopularRunRequest{
		Period: config.Period, ReleaseWindow: config.ReleaseWindow, Year: config.Year, TagName: "preview",
	}, now)
	if err != nil {
		return config, err
	}
	config.Period = normalized.Period
	config.ReleaseWindow = normalized.ReleaseWindow
	config.Year = normalized.Year
	if strings.TrimSpace(config.TagNameTemplate) == "" && !config.SkipTag {
		if config.Period == "year" {
			config.TagNameTemplate = "{date}_DL_year_{year}_popular"
		} else {
			config.TagNameTemplate = "{date}_DL_{period}_{release_window}_popular"
		}
	}
	if !config.SkipTag {
		_, err = renderWorkflowTagNameTemplate(config.TagNameTemplate, dlsitePopularTemplateValues(config, now))
	}
	return config, err
}

func dlsitePopularTemplateValues(config systemWorkflowTriggerConfig, now time.Time) map[string]string {
	period := map[string]string{"day": "24h", "week": "7d", "month": "30d", "year": "year"}[config.Period]
	releaseWindow := "all"
	if config.ReleaseWindow == "30d" {
		releaseWindow = "r30d"
	}
	return map[string]string{
		"date": now.UTC().Format("060102"), "period": period, "release_window": releaseWindow,
		"year": fmt.Sprint(config.Year),
	}
}

func renderWorkflowTagNameTemplate(template string, values map[string]string) (string, error) {
	template = strings.TrimSpace(template)
	if template == "" {
		return "", fmt.Errorf("tagNameTemplate is required")
	}
	if len([]rune(template)) > 160 {
		return "", fmt.Errorf("tagNameTemplate must be at most 160 characters")
	}
	var renderErr error
	rendered := workflowTagTemplateTokenPattern.ReplaceAllStringFunc(template, func(token string) string {
		key := strings.TrimSuffix(strings.TrimPrefix(token, "{"), "}")
		value, ok := values[key]
		if !ok {
			renderErr = fmt.Errorf("unsupported tagNameTemplate token: %s", token)
			return ""
		}
		return value
	})
	if renderErr != nil {
		return "", renderErr
	}
	if strings.ContainsAny(rendered, "{}") {
		return "", fmt.Errorf("tagNameTemplate contains an invalid token")
	}
	rendered = strings.TrimSpace(rendered)
	if rendered == "" {
		return "", fmt.Errorf("tagNameTemplate produces an empty tag")
	}
	return clampUserTagName(rendered), nil
}

func workflowTagFragment(value string) string {
	var builder strings.Builder
	separator := false
	for _, r := range strings.TrimSpace(value) {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_':
			builder.WriteRune(r)
			separator = false
		case !separator:
			builder.WriteRune('_')
			separator = true
		}
	}
	return strings.Trim(builder.String(), "_- ")
}

func validateWorkflowIntervalSchedule(scheduleJSON string) (workflowIntervalSchedule, error) {
	var schedule workflowIntervalSchedule
	if err := decodeStrictJSON(scheduleJSON, &schedule); err != nil {
		return workflowIntervalSchedule{}, fmt.Errorf("schedule JSON must contain intervalMinutes")
	}
	if schedule.IntervalMinutes < minimumWorkflowIntervalMinutes || schedule.IntervalMinutes > maximumWorkflowIntervalMinutes {
		return workflowIntervalSchedule{}, fmt.Errorf("intervalMinutes must be between %d and %d", minimumWorkflowIntervalMinutes, maximumWorkflowIntervalMinutes)
	}
	return schedule, nil
}

func decodeStrictJSON(raw string, target any) error {
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return fmt.Errorf("unexpected trailing JSON")
	}
	return nil
}

func (s *Server) dispatchDueScheduledWorkflowTrigger(ctx context.Context) error {
	if s.cfg.IsDemo() {
		return nil
	}
	var triggerID int64
	scheduledCodes := scheduledSystemWorkflowCodes()
	err := s.db.QueryRowContext(ctx, `
		SELECT trigger.id
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.enabled = 1
			AND trigger.trigger_type = 'schedule'
			AND trigger.next_run_at IS NOT NULL
			AND trigger.next_run_at <= CURRENT_TIMESTAMP
			AND definition.scope = 'system'
			AND definition.code IN (`+sqlPlaceholders(len(scheduledCodes))+`)
		ORDER BY trigger.next_run_at ASC, trigger.id ASC
		LIMIT 1
	`, stringArgs(scheduledCodes)...).Scan(&triggerID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	trigger, err := s.loadWorkflowTrigger(ctx, triggerID)
	if err != nil {
		return err
	}
	definition, err := s.loadWorkflowDefinition(ctx, trigger.WorkflowDefinitionID)
	if err != nil {
		return err
	}
	return s.dispatchDueSystemWorkflowTrigger(ctx, definition, trigger)
}

func (s *Server) dispatchDueSystemWorkflowTrigger(ctx context.Context, definition workflowDefinitionRecord, trigger workflowTriggerRecord) error {
	if !systemWorkflowSupportsConfigurableTriggers(definition.Code) {
		return s.disableInvalidWorkflowTrigger(ctx, trigger.ID, "system workflow schedule is not supported")
	}
	schedule, err := validateWorkflowIntervalSchedule(trigger.ScheduleJSON)
	if err != nil {
		return s.disableInvalidWorkflowTrigger(ctx, trigger.ID, err.Error())
	}
	now := time.Now().UTC()
	nextRunAt := formatWorkflowTimestamp(now.Add(time.Duration(schedule.IntervalMinutes) * time.Minute))
	var active int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_run WHERE trigger_id = ? AND status IN ('queued', 'running')", trigger.ID).Scan(&active); err != nil {
		return err
	}
	if active > 0 {
		_, err := s.db.ExecContext(ctx, "UPDATE workflow_trigger SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", nextRunAt, trigger.ID)
		return err
	}
	claim, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger SET next_run_at = ?, last_run_at = ?, last_error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= CURRENT_TIMESTAMP
	`, nextRunAt, formatWorkflowTimestamp(now), trigger.ID)
	if err != nil {
		return err
	}
	claimed, err := claim.RowsAffected()
	if err != nil || claimed == 0 {
		return err
	}
	go func() {
		_ = s.executeSystemWorkflowTrigger(ctx, definition, trigger, "schedule", "scheduled_interval")
	}()
	return nil
}

func (s *Server) executeSystemWorkflowTrigger(ctx context.Context, definition workflowDefinitionRecord, trigger workflowTriggerRecord, triggerType, triggerReason string) error {
	status, failures, runErr := s.dispatchSystemWorkflowTrigger(ctx, definition, trigger, triggerType, triggerReason)
	if runErr != nil {
		s.execBestEffort(ctx, "record workflow trigger failure", "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", runErr.Error(), trigger.ID)
		return runErr
	}
	if systemWorkflowTriggerIsAsync(definition.Code) {
		return nil
	}
	if status == "succeeded" || status == "" {
		_, runErr = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_success_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", trigger.ID)
		return runErr
	}
	message := strings.Join(failures, "; ")
	if message == "" {
		message = "workflow completed with status " + status
	}
	_, runErr = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", message, trigger.ID)
	return runErr
}

func (s *Server) dispatchSystemWorkflowTrigger(ctx context.Context, definition workflowDefinitionRecord, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	switch definition.Code {
	case "availability_watch":
		return s.executeAvailabilityWatchSystemTrigger(ctx, trigger, triggerType, triggerReason)
	case "local_library_scan":
		return s.executeLocalLibrarySystemTrigger(ctx, trigger, triggerType, triggerReason)
	case localMediaIndexWorkflowCode:
		return s.executeLocalMediaIndexSystemTrigger(ctx, trigger, triggerType, triggerReason)
	case "metadata_sync":
		return s.executeMetadataSystemTrigger(ctx, trigger, triggerType, triggerReason)
	case "remote_popular_collection":
		return s.executeRemotePopularSystemTrigger(ctx, trigger, triggerType, triggerReason)
	case "dlsite_popular_collection":
		return s.executeDLsitePopularSystemTrigger(ctx, trigger, triggerType, triggerReason)
	default:
		if isPresetWorkflowCode(definition.Code) {
			return s.executePresetSystemTrigger(ctx, definition, trigger, triggerType, triggerReason)
		}
		return "", nil, fmt.Errorf("system workflow trigger is not supported")
	}
}

func (s *Server) executeAvailabilityWatchSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	config, owner, err := s.loadAvailabilityWatchTriggerExecution(ctx, trigger)
	if err != nil {
		return "", nil, err
	}
	_ = config
	_, err = s.enqueueAvailabilityWatch(ctx, owner.ID, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return "succeeded", nil, err
}

func (s *Server) executeLocalLibrarySystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	config, err := normalizeLocalScanTriggerConfig(trigger.ConfigJSON)
	if err != nil {
		return "", nil, err
	}
	result, err := s.enqueueLocalScanWithOptions(ctx, triggerType, triggerReason, trigger.ID, config.FollowUpRun)
	return result.Status, result.Failures, err
}

func (s *Server) executeMetadataSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	var options metadataSyncOptions
	if strings.TrimSpace(trigger.ConfigJSON) != "" {
		if err := decodeStrictJSON(trigger.ConfigJSON, &options); err != nil {
			return "", nil, fmt.Errorf("metadata sync trigger config is invalid")
		}
	}
	options, err := s.validateMetadataSyncOptions(ctx, options)
	if err != nil {
		return "", nil, err
	}
	result, err := s.enqueueScopedDLsiteMetadataSync(ctx, triggerType, triggerReason, trigger.ID, options)
	return result.Status, result.Failures, err
}

func (s *Server) executeRemotePopularSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	config, owner, err := s.loadRemotePopularTriggerExecution(ctx, trigger)
	if err != nil {
		return "", nil, err
	}
	source, err := s.remoteCollectionSource(ctx, config.SourceID)
	if err != nil {
		return "", nil, err
	}
	tagName := ""
	if !config.SkipTag {
		tagName, err = renderWorkflowTagNameTemplate(config.TagNameTemplate, map[string]string{
			"date": time.Now().UTC().Format("060102"), "remote_name": workflowTagFragment(source.DisplayName),
			"source_code": workflowTagFragment(source.Code), "action": config.Action,
		})
		if err != nil {
			return "", nil, err
		}
	}
	_, err = s.runRemotePopularWorkflowWithTrigger(ctx, owner.ID, remoteCollectionRunRequest{
		SourceID: config.SourceID, Action: config.Action, Limit: config.Limit, TagName: tagName, SkipTag: config.SkipTag,
	}, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return "succeeded", nil, err
}

func (s *Server) executeDLsitePopularSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	config, owner, err := s.loadDLsitePopularTriggerExecution(ctx, trigger)
	if err != nil {
		return "", nil, err
	}
	now := time.Now()
	tagName := ""
	if !config.SkipTag {
		tagName, err = renderWorkflowTagNameTemplate(config.TagNameTemplate, dlsitePopularTemplateValues(config, now))
		if err != nil {
			return "", nil, err
		}
	}
	request, err := normalizeDLsitePopularRequest(dlsitePopularRunRequest{
		Period: config.Period, ReleaseWindow: config.ReleaseWindow, Year: config.Year, TagName: tagName, SkipTag: config.SkipTag,
	}, now)
	if err != nil {
		return "", nil, err
	}
	_, err = s.enqueueDLsitePopularCollectionWithTrigger(ctx, owner.ID, request, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return "succeeded", nil, err
}

func systemWorkflowTriggerIsAsync(code string) bool {
	switch code {
	case "availability_watch", "local_library_scan", localMediaIndexWorkflowCode, "metadata_sync", "remote_popular_collection", "dlsite_popular_collection":
		return true
	default:
		return isPresetWorkflowCode(code)
	}
}

func (s *Server) loadAvailabilityWatchTriggerExecution(ctx context.Context, trigger workflowTriggerRecord) (systemWorkflowTriggerConfig, currentUser, error) {
	var config systemWorkflowTriggerConfig
	if err := decodeStrictJSON(trigger.ConfigJSON, &config); err != nil {
		return config, currentUser{}, fmt.Errorf("%s trigger config is invalid", availabilityWatchDisplayName)
	}
	action, err := s.availabilityWatchConfiguredAction(ctx)
	if err != nil {
		return config, currentUser{}, err
	}
	permissions := []string{"workflows:run"}
	if availabilityWatchActionRequiresDownloads(action) {
		permissions = append(permissions, "downloads:manage")
	}
	owner, err := s.loadSystemWorkflowTriggerOwner(ctx, config.UserID, permissions)
	return config, owner, err
}

func (s *Server) loadRemotePopularTriggerExecution(ctx context.Context, trigger workflowTriggerRecord) (systemWorkflowTriggerConfig, currentUser, error) {
	var config systemWorkflowTriggerConfig
	if err := decodeStrictJSON(trigger.ConfigJSON, &config); err != nil {
		return config, currentUser{}, fmt.Errorf("remote popular trigger config is invalid")
	}
	owner, err := s.loadSystemWorkflowTriggerOwner(ctx, config.UserID, []string{"workflows:run", "tags:write"})
	if err != nil {
		return config, currentUser{}, err
	}
	if config.Action != "track" {
		return config, currentUser{}, fmt.Errorf("automated remote popular collection supports track only")
	}
	return config, owner, nil
}

func (s *Server) loadDLsitePopularTriggerExecution(ctx context.Context, trigger workflowTriggerRecord) (systemWorkflowTriggerConfig, currentUser, error) {
	var config systemWorkflowTriggerConfig
	if err := decodeStrictJSON(trigger.ConfigJSON, &config); err != nil {
		return config, currentUser{}, fmt.Errorf("DLsite popular trigger config is invalid")
	}
	owner, err := s.loadSystemWorkflowTriggerOwner(ctx, config.UserID, []string{"workflows:run", "metadata:sync", "tags:write"})
	return config, owner, err
}

func (s *Server) loadSystemWorkflowTriggerOwner(ctx context.Context, userID int64, permissions []string) (currentUser, error) {
	if userID <= 0 {
		return currentUser{}, fmt.Errorf("trigger owner is unavailable")
	}
	owner, err := s.accountStore.LoadByID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return currentUser{}, fmt.Errorf("trigger owner is unavailable")
	}
	if err != nil {
		return currentUser{}, err
	}
	if missing := missingWorkflowGraphPermission(owner.Permissions, permissions); missing != "" {
		return currentUser{}, fmt.Errorf("trigger owner no longer has required permission %s", missing)
	}
	return owner, nil
}

func (s *Server) dispatchStartupSystemWorkflowTriggers(ctx context.Context) error {
	triggerIDs, err := s.startupSystemWorkflowTriggerIDs(ctx)
	if err != nil {
		return err
	}
	var firstErr error
	for _, triggerID := range triggerIDs {
		if err := s.dispatchStartupSystemWorkflowTrigger(ctx, triggerID); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *Server) startupSystemWorkflowTriggerIDs(ctx context.Context) ([]int64, error) {
	startupCodes := append([]string{
		"local_library_scan", localMediaIndexWorkflowCode, "remote_popular_collection", "dlsite_popular_collection",
	}, presetWorkflowCodes()...)
	rows, err := s.db.QueryContext(ctx, `
		SELECT trigger.id
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.enabled = 1
			AND trigger.trigger_type = 'startup'
			AND definition.scope = 'system'
			AND definition.code IN (`+sqlPlaceholders(len(startupCodes))+`)
		ORDER BY trigger.id
	`, stringArgs(startupCodes)...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var triggerIDs []int64
	for rows.Next() {
		var triggerID int64
		if err := rows.Scan(&triggerID); err != nil {
			return nil, err
		}
		triggerIDs = append(triggerIDs, triggerID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return triggerIDs, nil
}

func (s *Server) dispatchStartupSystemWorkflowTrigger(ctx context.Context, triggerID int64) error {
	trigger, err := s.loadWorkflowTrigger(ctx, triggerID)
	if err != nil {
		return err
	}
	definition, err := s.loadWorkflowDefinition(ctx, trigger.WorkflowDefinitionID)
	if err != nil {
		return err
	}
	var active int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_run WHERE trigger_id = ? AND status IN ('queued', 'running')", trigger.ID).Scan(&active); err != nil {
		return err
	}
	if active > 0 {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_run_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", trigger.ID); err != nil {
		return err
	}
	return s.executeSystemWorkflowTrigger(ctx, definition, trigger, "startup", "application_startup")
}

func (s *Server) disableInvalidWorkflowTrigger(ctx context.Context, triggerID int64, message string) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = "scheduled workflow configuration is invalid"
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_trigger SET enabled = 0, next_run_at = NULL, last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
	`, message, triggerID)
	return err
}

func formatWorkflowTimestamp(value time.Time) string {
	return value.UTC().Format("2006-01-02 15:04:05")
}

func updateWorkflowTriggerSuccess(ctx context.Context, tx *sql.Tx, runID int64) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET last_success_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
	`, runID)
	return err
}

func updateWorkflowTriggerFailure(ctx context.Context, tx *sql.Tx, runID int64, message string) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
	`, message, runID)
	return err
}
