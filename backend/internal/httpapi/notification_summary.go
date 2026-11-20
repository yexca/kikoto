package httpapi

import (
	"net/http"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// notificationAttentionPreviewSize is how many runs needing attention the
// bell's panel lists; the rest are counted and linked to Workflows.
const notificationAttentionPreviewSize = 5

// notificationAttention is the workflow half of the bell: the runs that need a
// person's attention and the newest queued or running run.
type notificationAttention struct {
	// Total counts every run needing attention; Runs lists the newest few.
	Total int64                `json:"total"`
	Runs  []workflow.RunRecord `json:"runs"`
	// Running counts the queued and running runs; RunningRun is the newest.
	Running    int64               `json:"running"`
	RunningRun *workflow.RunRecord `json:"runningRun"`
}

// notificationSummary is everything the header bell shows, decided here: the
// badge count, one page of notifications, and the workflow attention state.
type notificationSummary struct {
	// UnreadCount is the badge: undismissed notifications plus runs needing
	// attention.
	UnreadCount int64 `json:"unreadCount"`
	// Notifications is null for an account without library access.
	Notifications *workflowNotificationsPage `json:"notifications"`
	// Attention is null for an account that cannot list workflow runs.
	Attention *notificationAttention `json:"attention"`
}

// notificationSummary answers one poll of the header bell. The notification
// page takes the same page and pageSize as the notification list.
func (s *Server) notificationSummary(w http.ResponseWriter, r *http.Request) {
	actor, ok := userFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "login required"})
		return
	}
	// A demo reads every list, as the lists themselves do.
	allowed := func(permission string) bool { return s.cfg.IsDemo() || userHasPermission(actor, permission) }
	canNotify, canListRuns := allowed("library:read"), allowed("workflows:run")
	if !canNotify && !canListRuns {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "permission denied"})
		return
	}
	var summary notificationSummary
	if canNotify {
		page, pageSize := notificationPageParams(r)
		notifications, err := s.loadNotificationsPage(r.Context(), actor.ID, page, pageSize)
		if err != nil {
			writeError(w, err)
			return
		}
		summary.Notifications = &notifications
		summary.UnreadCount += notifications.Total
	}
	if canListRuns {
		attention, err := s.loadNotificationAttention(r, actor)
		if err != nil {
			writeError(w, err)
			return
		}
		summary.Attention = &attention
		summary.UnreadCount += attention.Total
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) loadNotificationAttention(r *http.Request, actor currentUser) (notificationAttention, error) {
	options := workflow.ListRunsOptions{
		Page: 1, PageSize: notificationAttentionPreviewSize, View: "attention",
		ViewerUserID: actor.ID, CanViewAll: canViewAllWorkflowRuns(actor), DemoShowcase: s.cfg.IsDemo(),
	}
	ctx := r.Context()
	page, err := s.workflowStore.ListRuns(ctx, options)
	if err != nil {
		return notificationAttention{}, err
	}
	redactor := s.remoteAddressRedactorFor(ctx)
	redactor.runs(page.Runs)
	attention := notificationAttention{Total: page.Total, Runs: page.Runs, Running: page.ViewTotals.Running}
	if attention.Running > 0 {
		options.View, options.PageSize = "running", 1
		running, err := s.workflowStore.ListRuns(ctx, options)
		if err != nil {
			return notificationAttention{}, err
		}
		redactor.runs(running.Runs)
		if len(running.Runs) > 0 {
			attention.RunningRun = &running.Runs[0]
		}
	}
	return attention, nil
}
