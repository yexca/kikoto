package httpapi

// Workflow graph schema, node capabilities, and shared graph types.

import (
	"regexp"

	"github.com/yexca/kikoto/backend/internal/workcode"
)

// A workflow graph is the typed DAG that preset workflows compose on the server.
// It runs as one recoverable job whose persisted worker type remains
// "custom_workflow" for existing queues and run history.
const workflowGraphSchemaVersion = 2

var (
	workflowGraphIDPattern       = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	workflowGraphWorkCodePattern = regexp.MustCompile(`(?i)^(?:` + workcode.PrefixAlternation + `)` + workcode.Digits + `$`)
)

type workflowGraphDefinition struct {
	SchemaVersion int                 `json:"schemaVersion"`
	Nodes         []workflowGraphNode `json:"nodes"`
	Edges         []workflowGraphEdge `json:"edges"`
	Policy        workflowGraphPolicy `json:"policy,omitempty"`
}

type workflowGraphPolicy struct {
	RequirePreview *bool `json:"requirePreview,omitempty"`
}

type workflowGraphNode struct {
	ID          string                `json:"id"`
	Type        string                `json:"type"`
	DisplayName string                `json:"displayName"`
	Config      map[string]any        `json:"config"`
	Position    workflowGraphPosition `json:"position"`
}

type workflowGraphPosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type workflowGraphEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	SourceHandle string `json:"sourceHandle"`
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
}

type workflowGraph struct {
	Definition       workflowGraphDefinition
	NodesByID        map[string]workflowGraphNode
	IncomingByNode   map[string][]workflowGraphEdge
	TopologicalOrder []string
}

type workflowGraphEdgeState struct {
	edgeIDs     map[string]bool
	targetPorts map[string]bool
	incoming    map[string][]workflowGraphEdge
	adjacency   map[string][]string
	indegree    map[string]int
}

type workflowRunGraph struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Nodes         []workflowRunGraphNode `json:"nodes"`
	Edges         []workflowRunGraphEdge `json:"edges"`
}

type workflowRunGraphNode struct {
	ID          string                 `json:"id"`
	Type        string                 `json:"type"`
	DisplayName string                 `json:"displayName"`
	Position    workflowGraphPosition  `json:"position"`
	Inputs      []workflowRunGraphPort `json:"inputs"`
	Outputs     []workflowRunGraphPort `json:"outputs"`
}

type workflowRunGraphPort struct {
	ID       string `json:"id"`
	DataType string `json:"dataType"`
}

type workflowRunGraphEdge struct {
	ID           string `json:"id"`
	Source       string `json:"source"`
	SourceHandle string `json:"sourceHandle"`
	Target       string `json:"target"`
	TargetHandle string `json:"targetHandle"`
	DataType     string `json:"dataType"`
}

type workflowGraphPort struct {
	ID       string
	DataType string
	Required bool
}

type workflowGraphCapability struct {
	Type        string
	Phase       string
	DisplayName string
	Description string
	Inputs      []workflowGraphPort
	Outputs     []workflowGraphPort
	Permissions []string
	Composite   bool
	ConfigKeys  []string
}

var workflowGraphCapabilities = map[string]workflowGraphCapability{
	"circle_catalog": {
		Type: "circle_catalog", Phase: "discover", DisplayName: "Circle catalog",
		Description: "Read or refresh a circle catalog without materializing every discovered work.",
		Inputs:      []workflowGraphPort{{ID: "circle", DataType: "circle_id", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "works", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"circleId", "mode", "maxWorks"},
	},
	"series_catalog": {
		Type: "series_catalog", Phase: "discover", DisplayName: "Series catalog",
		Description: "Read stored work codes for one provider series without creating works.",
		Inputs:      []workflowGraphPort{{ID: "series", DataType: "series_id", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "works", DataType: "work_candidates"}}, Composite: true,
		ConfigKeys: []string{"seriesId", "circleExternalId", "maxWorks"},
	},
	"voice_catalog": {
		Type: "voice_catalog", Phase: "discover", DisplayName: "Voice actor catalog",
		Description: "Read or refresh a voice actor's persisted remote catalog without materializing discovered works.",
		Outputs:     []workflowGraphPort{{ID: "works", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"personId", "sourceIds", "mode", "maxWorks"},
	},
	"circle_metadata": {
		Type: "circle_metadata", Phase: "commit", DisplayName: "Refresh circle metadata",
		Description: "Synchronize provider metadata for a circle's catalog works that lack it, or for every catalog work.",
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"circleId", "productMode"},
	},
	"circle_sources": {
		Type: "circle_sources", Phase: "discover", DisplayName: "Check circle sources",
		Description: "Match a circle's works on the selected compatible remote sources.",
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"circleId", "sourceIds", "mode"},
	},
	"voice_metadata": {
		Type: "voice_metadata", Phase: "commit", DisplayName: "Refresh known-work metadata",
		Description: "Synchronize provider metadata for a voice actor's known works that lack it, or for every known work.",
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"personId", "mode"},
	},
	"filter_works": {
		Type: "filter_works", Phase: "filter", DisplayName: "Filter works",
		Description: "Apply bounded, structured filters to work candidates.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "accepted", DataType: "work_candidates"}, {ID: "rejected", DataType: "work_candidates"}},
		ConfigKeys:  []string{"limit", "codePrefix", "existing", "releaseFrom", "releaseTo", "voiceNames", "metadataTags", "userTags"},
	},
	"metadata_sync": {
		Type: "metadata_sync", Phase: "commit", DisplayName: "Sync metadata",
		Description: "Materialize accepted candidates and synchronize normalized provider metadata.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"metadata:sync"}, Composite: true, ConfigKeys: []string{"maxWorks"},
	},
	"track_works": {
		Type: "track_works", Phase: "execute", DisplayName: "Track works",
		Description: "Track available source works through the existing remote sync domain operation.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"remote:track"}, Composite: true, ConfigKeys: []string{"sourceId", "maxWorks"},
	},
	"fetch_works": {
		Type: "fetch_works", Phase: "execute", DisplayName: "Fetch works",
		Description: "Queue the existing recoverable Fetch transaction for bounded, filtered remote files.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_candidates", Required: true}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_candidates"}},
		Permissions: []string{"remote:fetch"}, Composite: true,
		ConfigKeys: []string{"sourceId", "excludeExtensions", "maxWorks", "maxFiles", "maxBytes", "minFreeBytes", "allowUnknownSizes", "targetRoot"},
	},
	"tag_works": {
		Type: "tag_works", Phase: "commit", DisplayName: "Tag works",
		Description: "Assign a user-owned tag to works materialized by prior actions.",
		Inputs:      []workflowGraphPort{{ID: "works", DataType: "work_refs", Required: true}, {ID: "tag", DataType: "text"}},
		Outputs:     []workflowGraphPort{{ID: "completed", DataType: "work_refs"}, {ID: "failed", DataType: "work_refs"}},
		Permissions: []string{"tags:write"}, Composite: true, ConfigKeys: []string{"tagName"},
	},
}
