package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// remoteFetchFile is one planned file of a Fetch run as the run detail shows
// it. Path is relative to the work folder so the response never carries a
// local root.
type remoteFetchFile struct {
	Path         string `json:"path"`
	Kind         string `json:"kind"`
	Action       string `json:"action"`
	State        string `json:"state"`
	SizeBytes    *int64 `json:"sizeBytes"`
	BytesCurrent int64  `json:"bytesCurrent"`
}

// remoteFetchCacheOutput is the part of the cache node output that locates the
// item the download loop last touched.
type remoteFetchCacheOutput struct {
	Current          *int   `json:"current"`
	ItemKey          string `json:"item_key"`
	ItemBytesCurrent int64  `json:"item_bytes_current"`
}

func (s *Server) listWorkflowRunFetchFiles(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid workflow run id"})
		return
	}
	if !s.requireWorkflowRunAccess(w, r, actor, id) {
		return
	}
	files, err := s.remoteFetchFiles(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "fetch files not found"})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runId": id, "files": files})
}

func (s *Server) remoteFetchFiles(ctx context.Context, runID int64) ([]remoteFetchFile, error) {
	manifest, err := s.loadRemoteFetchManifest(ctx, runID)
	if err != nil {
		return nil, err
	}
	var plan remoteWorkSavePlan
	if err := json.Unmarshal([]byte(manifest.PlanJSON), &plan); err != nil {
		return nil, err
	}
	var runStatus, nodeStatus, outputJSON string
	err = s.db.QueryRowContext(ctx, `
		SELECT run.status, COALESCE(node.status, ''), COALESCE(node.output_json, '')
		FROM workflow_run AS run
		LEFT JOIN workflow_node_run AS node ON node.workflow_run_id = run.id AND node.node_id = 'cache'
		WHERE run.id = ?
	`, runID).Scan(&runStatus, &nodeStatus, &outputJSON)
	if err != nil {
		return nil, err
	}
	var output remoteFetchCacheOutput
	if strings.TrimSpace(outputJSON) != "" {
		// A malformed progress snapshot only loses the live position.
		_ = json.Unmarshal([]byte(outputJSON), &output)
	}
	return remoteFetchFileStates(plan, effectiveFetchCacheStatus(nodeStatus, runStatus), output), nil
}

// effectiveFetchCacheStatus lets a stopped run settle a cache node that was
// still marked running when the run ended.
func effectiveFetchCacheStatus(nodeStatus string, runStatus string) string {
	if nodeStatus == "running" {
		switch runStatus {
		case "failed", "partial", "cancelled":
			return runStatus
		}
	}
	return nodeStatus
}

// remoteFetchFileStates derives each file's state from the persisted plan and
// the cache node's progress. The download loop visits items in plan order, so
// every item before the reported position is finished, the reported item is
// the one in flight, and the rest are waiting.
func remoteFetchFileStates(plan remoteWorkSavePlan, nodeStatus string, output remoteFetchCacheOutput) []remoteFetchFile {
	finished := 0
	active := -1
	switch nodeStatus {
	case "succeeded":
		finished = len(plan.Items)
	case "", "pending", "queued", "skipped":
	default:
		if output.Current != nil {
			finished = min(max(*output.Current, 0), len(plan.Items))
		}
		if output.ItemKey != "" {
			for index, item := range plan.Items {
				if item.ItemKey == output.ItemKey {
					if index >= finished {
						active = index
					}
					break
				}
			}
		}
	}
	files := make([]remoteFetchFile, 0, len(plan.Items))
	for index, item := range plan.Items {
		if item.Action == "exclude" {
			continue
		}
		file := remoteFetchFile{
			Path:      remoteFetchFileDisplayPath(plan.SaveRoot, item),
			Kind:      item.Kind,
			Action:    item.Action,
			State:     "pending",
			SizeBytes: item.SizeBytes,
		}
		switch {
		case index < finished:
			file.State = "done"
			if item.SizeBytes != nil {
				file.BytesCurrent = *item.SizeBytes
			}
		case index == active:
			file.State = activeFetchFileState(nodeStatus)
			file.BytesCurrent = max(output.ItemBytesCurrent, 0)
		}
		files = append(files, file)
	}
	return files
}

func activeFetchFileState(nodeStatus string) string {
	switch nodeStatus {
	case "failed":
		return "failed"
	case "partial":
		return "paused"
	case "cancelled":
		return "stopped"
	default:
		return "active"
	}
}

func remoteFetchFileDisplayPath(saveRoot string, item remoteWorkSavePlanItem) string {
	root := strings.TrimSuffix(saveRoot, "/")
	if root != "" && strings.HasPrefix(item.TargetPath, root+"/") {
		return strings.TrimPrefix(item.TargetPath, root+"/")
	}
	return strings.TrimPrefix(item.Path, "/")
}
