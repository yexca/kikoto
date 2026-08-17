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
	minimumCustomWorkflowIntervalMinutes = 5
	maximumCustomWorkflowIntervalMinutes = 7 * 24 * 60
)

type customWorkflowSchedule struct {
	IntervalMinutes int `json:"intervalMinutes"`
}

type customWorkflowScheduleConfig struct {
	Inputs map[string]any `json:"inputs"`
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
}

type localScanTriggerConfig struct {
	FollowUpRun bool `json:"followUpRun"`
}

var workflowTagTemplateTokenPattern = regexp.MustCompile(`\{[a-z_]+\}`)

func (s *Server) prepareWorkflowTrigger(ctx context.Context, actor currentUser, definition workflowDefinitionRecord, payload workflowTriggerPayload, now time.Time, existing *workflowTriggerRecord) (preparedWorkflowTrigger, error) {
	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if json.Unmarshal([]byte(definition.DefinitionJSON), &probe) != nil || probe.SchemaVersion != customWorkflowSchemaVersion {
		return s.prepareSystemWorkflowTrigger(ctx, actor, definition, payload, now, existing)
	}
	if definition.Scope != "user" || !definition.Editable {
		return preparedWorkflowTrigger{}, fmt.Errorf("automated DAG must be an editable user workflow")
	}
	if payload.TriggerType != "schedule" && payload.TriggerType != "startup" {
		return preparedWorkflowTrigger{}, fmt.Errorf("custom workflow DAGs support startup and interval schedule triggers only")
	}
	var graph customWorkflowGraph
	var schedule customWorkflowSchedule
	var err error
	if payload.TriggerType == "schedule" {
		graph, schedule, _, err = validateCustomWorkflowSchedule(definition, payload.ScheduleJSON, payload.ConfigJSON)
	} else {
		graph, _, err = validateCustomWorkflowAutomation(definition, payload.ConfigJSON)
	}
	if err != nil {
		return preparedWorkflowTrigger{}, err
	}
	if missing := missingCustomWorkflowPermission(actor.Permissions, customWorkflowRequiredPermissions(graph)); missing != "" {
		return preparedWorkflowTrigger{}, fmt.Errorf("automated workflow requires permission %s", missing)
	}
	prepared := preparedWorkflowTrigger{ConfigJSON: payload.ConfigJSON}
	if payload.TriggerType == "startup" {
		return prepared, nil
	}
	if payload.Enabled != nil && !*payload.Enabled {
		return prepared, nil
	}
	prepared.NextRunAt = formatWorkflowTimestamp(now.Add(time.Duration(schedule.IntervalMinutes) * time.Minute))
	return prepared, nil
}

func (s *Server) prepareSystemWorkflowTrigger(ctx context.Context, actor currentUser, definition workflowDefinitionRecord, payload workflowTriggerPayload, now time.Time, existing *workflowTriggerRecord) (preparedWorkflowTrigger, error) {
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
	if missing := missingCustomWorkflowPermission(actor.Permissions, requiredPermissions); missing != "" {
		return preparedWorkflowTrigger{}, fmt.Errorf("automated workflow requires permission %s", missing)
	}
	return prepared, nil
}

func prepareSystemWorkflowTriggerTiming(definition workflowDefinitionRecord, payload workflowTriggerPayload, now time.Time, existing *workflowTriggerRecord) (preparedWorkflowTrigger, error) {
	prepared := preparedWorkflowTrigger{ConfigJSON: "{}"}
	if definition.Code == "availability_watch" && payload.TriggerType != "schedule" {
		return preparedWorkflowTrigger{}, fmt.Errorf("Availability Watch supports one interval schedule only")
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
		}
		prepared.ConfigJSON = mustJSON(config)
		requiredPermissions = append(requiredPermissions, "metadata:sync")
	case "metadata_sync":
		requiredPermissions = append(requiredPermissions, "metadata:sync")
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
	}
	return prepared, requiredPermissions, nil
}

func normalizeLocalScanTriggerConfig(raw string) (localScanTriggerConfig, error) {
	config := localScanTriggerConfig{}
	if strings.TrimSpace(raw) == "" {
		raw = "{}"
	}
	if err := decodeStrictJSON(raw, &config); err != nil {
		return config, fmt.Errorf("local scan trigger config is invalid")
	}
	return config, nil
}

func systemWorkflowSupportsConfigurableTriggers(code string) bool {
	switch code {
	case "availability_watch", "local_library_scan", "metadata_sync", "remote_popular_collection", "dlsite_popular_collection":
		return true
	default:
		return false
	}
}

func (s *Server) ensureAvailabilityWatchSchedule(ctx context.Context, definition workflowDefinitionRecord, excludeID int64, triggerType string) error {
	if definition.Code != "availability_watch" {
		return nil
	}
	if triggerType != "schedule" {
		return fmt.Errorf("Availability Watch supports one interval schedule only")
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
		return fmt.Errorf("Availability Watch already has a schedule")
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
	if strings.TrimSpace(config.TagNameTemplate) == "" {
		config.TagNameTemplate = "{date}_{remote_name}_popular"
	}
	_, err = renderWorkflowTagNameTemplate(config.TagNameTemplate, map[string]string{
		"date": now.UTC().Format("060102"), "remote_name": workflowTagFragment(source.DisplayName),
		"source_code": workflowTagFragment(source.Code), "action": config.Action,
	})
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
	if strings.TrimSpace(config.TagNameTemplate) == "" {
		if config.Period == "year" {
			config.TagNameTemplate = "{date}_DL_year_{year}_popular"
		} else {
			config.TagNameTemplate = "{date}_DL_{period}_{release_window}_popular"
		}
	}
	_, err = renderWorkflowTagNameTemplate(config.TagNameTemplate, dlsitePopularTemplateValues(config, now))
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
	if runes := []rune(rendered); len(runes) > 40 {
		rendered = string(runes[:40])
	}
	return rendered, nil
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

func validateCustomWorkflowAutomation(definition workflowDefinitionRecord, configJSON string) (customWorkflowGraph, map[string]any, error) {
	graph, err := validateCustomWorkflowDefinition(definition.DefinitionJSON)
	if err != nil {
		return customWorkflowGraph{}, nil, err
	}
	if customWorkflowRequiresPreview(graph.Definition) {
		return customWorkflowGraph{}, nil, fmt.Errorf("automated workflows must disable interactive preview")
	}
	config := customWorkflowScheduleConfig{Inputs: map[string]any{}}
	if err := decodeStrictJSON(configJSON, &config); err != nil {
		return customWorkflowGraph{}, nil, fmt.Errorf("config JSON must contain only workflow inputs")
	}
	inputs, err := normalizeCustomWorkflowInputs(graph.Definition.Inputs, config.Inputs)
	if err != nil {
		return customWorkflowGraph{}, nil, err
	}
	return graph, inputs, nil
}

func validateWorkflowIntervalSchedule(scheduleJSON string) (customWorkflowSchedule, error) {
	var schedule customWorkflowSchedule
	if err := decodeStrictJSON(scheduleJSON, &schedule); err != nil {
		return customWorkflowSchedule{}, fmt.Errorf("schedule JSON must contain intervalMinutes")
	}
	if schedule.IntervalMinutes < minimumCustomWorkflowIntervalMinutes || schedule.IntervalMinutes > maximumCustomWorkflowIntervalMinutes {
		return customWorkflowSchedule{}, fmt.Errorf("intervalMinutes must be between %d and %d", minimumCustomWorkflowIntervalMinutes, maximumCustomWorkflowIntervalMinutes)
	}
	return schedule, nil
}

func validateCustomWorkflowSchedule(definition workflowDefinitionRecord, scheduleJSON, configJSON string) (customWorkflowGraph, customWorkflowSchedule, map[string]any, error) {
	graph, inputs, err := validateCustomWorkflowAutomation(definition, configJSON)
	if err != nil {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, err
	}
	schedule, err := validateWorkflowIntervalSchedule(scheduleJSON)
	if err != nil {
		return customWorkflowGraph{}, customWorkflowSchedule{}, nil, err
	}
	return graph, schedule, inputs, nil
}

func (s *Server) validateWorkflowDefinitionTriggerUpdate(ctx context.Context, definition workflowDefinitionRecord, definitionJSON string) error {
	var probe struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if json.Unmarshal([]byte(definitionJSON), &probe) != nil || probe.SchemaVersion != customWorkflowSchemaVersion {
		return nil
	}
	definition.DefinitionJSON = definitionJSON
	rows, err := s.db.QueryContext(ctx, `
		SELECT trigger_type, schedule_json, config_json
		FROM workflow_trigger WHERE workflow_definition_id = ? ORDER BY id
	`, definition.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var triggerType, scheduleJSON, configJSON string
		if err := rows.Scan(&triggerType, &scheduleJSON, &configJSON); err != nil {
			return err
		}
		if triggerType != "schedule" && triggerType != "startup" {
			return fmt.Errorf("remove unsupported %s triggers before upgrading this workflow", triggerType)
		}
		if triggerType == "schedule" {
			if _, _, _, err := validateCustomWorkflowSchedule(definition, scheduleJSON, configJSON); err != nil {
				return fmt.Errorf("existing schedule is incompatible with this workflow: %w", err)
			}
		} else if _, _, err := validateCustomWorkflowAutomation(definition, configJSON); err != nil {
			return fmt.Errorf("existing startup trigger is incompatible with this workflow: %w", err)
		}
	}
	return rows.Err()
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

func (s *Server) dispatchDueCustomWorkflowTrigger(ctx context.Context) error {
	if s.cfg.IsDemo() {
		return nil
	}
	var triggerID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT trigger.id
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.enabled = 1
			AND trigger.trigger_type = 'schedule'
			AND trigger.next_run_at IS NOT NULL
			AND trigger.next_run_at <= CURRENT_TIMESTAMP
			AND (
				(definition.scope = 'user' AND json_extract(definition.definition_json, '$.schemaVersion') = ?)
				OR (definition.scope = 'system' AND definition.code IN (
					'availability_watch', 'local_library_scan', 'metadata_sync',
					'remote_popular_collection', 'dlsite_popular_collection'
				))
			)
		ORDER BY trigger.next_run_at ASC, trigger.id ASC
		LIMIT 1
	`, customWorkflowSchemaVersion).Scan(&triggerID)
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
	if definition.Scope == "system" {
		return s.dispatchDueSystemWorkflowTrigger(ctx, definition, trigger)
	}
	return s.dispatchLoadedCustomWorkflowTrigger(ctx, definition, trigger)
}

func (s *Server) dispatchLoadedCustomWorkflowTrigger(ctx context.Context, definition workflowDefinitionRecord, trigger workflowTriggerRecord) error {
	if definition.OwnerUserID == nil {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "scheduled workflow owner is unavailable")
	}
	owner, err := s.accountStore.LoadByID(ctx, *definition.OwnerUserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "scheduled workflow owner is unavailable")
		}
		return err
	}
	graph, schedule, inputs, err := validateCustomWorkflowSchedule(definition, trigger.ScheduleJSON, trigger.ConfigJSON)
	if err != nil {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, err.Error())
	}
	if missing := missingCustomWorkflowPermission(owner.Permissions, customWorkflowRequiredPermissions(graph)); missing != "" {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "scheduled workflow owner no longer has required permissions")
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
		UPDATE workflow_trigger SET next_run_at = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= CURRENT_TIMESTAMP
	`, nextRunAt, trigger.ID)
	if err != nil {
		return err
	}
	claimed, err := claim.RowsAffected()
	if err != nil || claimed == 0 {
		return err
	}
	_, err = s.enqueueCustomWorkflow(ctx, definition, graph, owner.ID, owner.Permissions, inputs, "", customWorkflowEnqueueOptions{
		TriggerID: trigger.ID, TriggerType: "schedule", TriggerReason: "scheduled_interval", DefinitionStack: []int64{definition.ID},
	})
	if err != nil {
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", "scheduled workflow could not be queued", trigger.ID)
		return err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_run_at = ?, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", formatWorkflowTimestamp(now), trigger.ID)
	return err
}

func (s *Server) dispatchDueSystemWorkflowTrigger(ctx context.Context, definition workflowDefinitionRecord, trigger workflowTriggerRecord) error {
	if !systemWorkflowSupportsConfigurableTriggers(definition.Code) {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "system workflow schedule is not supported")
	}
	schedule, err := validateWorkflowIntervalSchedule(trigger.ScheduleJSON)
	if err != nil {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, err.Error())
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
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", runErr.Error(), trigger.ID)
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
	case "metadata_sync":
		return s.executeMetadataSystemTrigger(ctx, trigger, triggerType, triggerReason)
	case "remote_popular_collection":
		return s.executeRemotePopularSystemTrigger(ctx, trigger, triggerType, triggerReason)
	case "dlsite_popular_collection":
		return s.executeDLsitePopularSystemTrigger(ctx, trigger, triggerType, triggerReason)
	default:
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
	result, err := s.enqueueDLsiteMetadataSyncWithTrigger(ctx, triggerType, triggerReason, trigger.ID)
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
	tagName, err := renderWorkflowTagNameTemplate(config.TagNameTemplate, map[string]string{
		"date": time.Now().UTC().Format("060102"), "remote_name": workflowTagFragment(source.DisplayName),
		"source_code": workflowTagFragment(source.Code), "action": config.Action,
	})
	if err != nil {
		return "", nil, err
	}
	_, err = s.runRemotePopularWorkflowWithTrigger(ctx, owner.ID, remoteCollectionRunRequest{
		SourceID: config.SourceID, Action: config.Action, Limit: config.Limit, TagName: tagName,
	}, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return "succeeded", nil, err
}

func (s *Server) executeDLsitePopularSystemTrigger(ctx context.Context, trigger workflowTriggerRecord, triggerType, triggerReason string) (string, []string, error) {
	config, owner, err := s.loadDLsitePopularTriggerExecution(ctx, trigger)
	if err != nil {
		return "", nil, err
	}
	now := time.Now()
	tagName, err := renderWorkflowTagNameTemplate(config.TagNameTemplate, dlsitePopularTemplateValues(config, now))
	if err != nil {
		return "", nil, err
	}
	request, err := normalizeDLsitePopularRequest(dlsitePopularRunRequest{
		Period: config.Period, ReleaseWindow: config.ReleaseWindow, Year: config.Year, TagName: tagName,
	}, now)
	if err != nil {
		return "", nil, err
	}
	_, err = s.enqueueDLsitePopularCollectionWithTrigger(ctx, owner.ID, request, workflowRunTrigger{Type: triggerType, Reason: triggerReason, ID: trigger.ID})
	return "succeeded", nil, err
}

func systemWorkflowTriggerIsAsync(code string) bool {
	switch code {
	case "availability_watch", "local_library_scan", "metadata_sync", "remote_popular_collection", "dlsite_popular_collection":
		return true
	default:
		return false
	}
}

func (s *Server) loadAvailabilityWatchTriggerExecution(ctx context.Context, trigger workflowTriggerRecord) (systemWorkflowTriggerConfig, currentUser, error) {
	var config systemWorkflowTriggerConfig
	if err := decodeStrictJSON(trigger.ConfigJSON, &config); err != nil {
		return config, currentUser{}, fmt.Errorf("Availability Watch trigger config is invalid")
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
	if missing := missingCustomWorkflowPermission(owner.Permissions, permissions); missing != "" {
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
	rows, err := s.db.QueryContext(ctx, `
		SELECT trigger.id
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.enabled = 1
			AND trigger.trigger_type = 'startup'
			AND definition.scope = 'system'
			AND definition.code IN (
				'local_library_scan', 'metadata_sync',
				'remote_popular_collection', 'dlsite_popular_collection'
			)
		ORDER BY trigger.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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

func (s *Server) dispatchStartupCustomWorkflowTriggers(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
		SELECT trigger.id
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE trigger.enabled = 1
			AND trigger.trigger_type = 'startup'
			AND definition.scope = 'user'
			AND json_extract(definition.definition_json, '$.schemaVersion') = ?
		ORDER BY trigger.id
	`, customWorkflowSchemaVersion)
	if err != nil {
		return err
	}
	var triggerIDs []int64
	for rows.Next() {
		var triggerID int64
		if err := rows.Scan(&triggerID); err != nil {
			_ = rows.Close()
			return err
		}
		triggerIDs = append(triggerIDs, triggerID)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var firstErr error
	for _, triggerID := range triggerIDs {
		if err := s.dispatchStartupCustomWorkflowTrigger(ctx, triggerID); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *Server) dispatchStartupCustomWorkflowTrigger(ctx context.Context, triggerID int64) error {
	trigger, err := s.loadWorkflowTrigger(ctx, triggerID)
	if err != nil {
		return err
	}
	definition, err := s.loadWorkflowDefinition(ctx, trigger.WorkflowDefinitionID)
	if err != nil {
		return err
	}
	if definition.OwnerUserID == nil {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "startup workflow owner is unavailable")
	}
	owner, err := s.accountStore.LoadByID(ctx, *definition.OwnerUserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "startup workflow owner is unavailable")
		}
		return err
	}
	graph, inputs, err := validateCustomWorkflowAutomation(definition, trigger.ConfigJSON)
	if err != nil {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, err.Error())
	}
	if missing := missingCustomWorkflowPermission(owner.Permissions, customWorkflowRequiredPermissions(graph)); missing != "" {
		return s.disableInvalidCustomWorkflowTrigger(ctx, trigger.ID, "startup workflow owner no longer has required permissions")
	}
	var active int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_run WHERE trigger_id = ? AND status IN ('queued', 'running')", trigger.ID).Scan(&active); err != nil {
		return err
	}
	if active > 0 {
		return nil
	}
	_, err = s.enqueueCustomWorkflow(ctx, definition, graph, owner.ID, owner.Permissions, inputs, "", customWorkflowEnqueueOptions{
		TriggerID: trigger.ID, TriggerType: "startup", TriggerReason: "application_startup", DefinitionStack: []int64{definition.ID},
	})
	if err != nil {
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", "startup workflow could not be queued", trigger.ID)
		return err
	}
	_, err = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_run_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", trigger.ID)
	return err
}

func (s *Server) disableInvalidCustomWorkflowTrigger(ctx context.Context, triggerID int64, message string) error {
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

func updateCustomWorkflowTriggerSuccess(ctx context.Context, tx *sql.Tx, runID int64) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET last_success_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
	`, runID)
	return err
}

func updateCustomWorkflowTriggerFailure(ctx context.Context, tx *sql.Tx, runID int64, message string) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
	`, message, runID)
	return err
}
