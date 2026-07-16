package httpapi

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestValidateCustomWorkflowDefinitionBuildsTypedDAG(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"command":{"enabled":true,"alias":"getCircle"},
		"inputs":[{"key":"circle","label":"Circle","type":"circle_id","required":true}],
		"nodes":[
			{"id":"input_circle","type":"workflow_input","config":{"inputKey":"circle"},"position":{"x":0,"y":0}},
			{"id":"catalog","type":"circle_catalog","config":{"mode":"stored","maxWorks":100},"position":{"x":200,"y":0}},
			{"id":"filter","type":"filter_works","config":{"limit":50},"position":{"x":400,"y":0}},
			{"id":"available","type":"check_source_availability","config":{"sourceId":7},"position":{"x":600,"y":0}},
			{"id":"track","type":"track_works","config":{"maxWorks":50},"position":{"x":800,"y":0}}
		],
		"edges":[
			{"id":"e1","source":"input_circle","sourceHandle":"value","target":"catalog","targetHandle":"circle"},
			{"id":"e2","source":"catalog","sourceHandle":"works","target":"filter","targetHandle":"works"},
			{"id":"e3","source":"filter","sourceHandle":"accepted","target":"available","targetHandle":"works"},
			{"id":"e4","source":"available","sourceHandle":"available","target":"track","targetHandle":"works"}
		]
	}`
	graph, err := validateCustomWorkflowDefinition(raw)
	if err != nil {
		t.Fatalf("validateCustomWorkflowDefinition() error = %v", err)
	}
	want := []string{"input_circle", "catalog", "filter", "available", "track"}
	if strings.Join(graph.TopologicalOrder, ",") != strings.Join(want, ",") {
		t.Fatalf("topological order = %v, want %v", graph.TopologicalOrder, want)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsPortMismatch(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"text","type":"input_text","config":{"value":"RG00001"}},
			{"id":"catalog","type":"circle_catalog","config":{"mode":"stored","maxWorks":10}}
		],
		"edges":[{"id":"bad","source":"text","sourceHandle":"value","target":"catalog","targetHandle":"circle"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "incompatible edge") {
		t.Fatalf("error = %v, want incompatible edge", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsCycle(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"first","type":"template_text","config":{"template":"{{.Value}}"}},
			{"id":"second","type":"template_text","config":{"template":"{{.Value}}"}}
		],
		"edges":[
			{"id":"one","source":"first","sourceHandle":"text","target":"second","targetHandle":"value"},
			{"id":"two","source":"second","sourceHandle":"text","target":"first","targetHandle":"value"}
		]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "acyclic") {
		t.Fatalf("error = %v, want acyclic validation", err)
	}
}

func TestValidateCustomWorkflowDefinitionRequiresExplicitAutomaticFetchBounds(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"policy":{"requirePreview":false},
		"nodes":[
			{"id":"works","type":"input_work","config":{"codes":["RJ01234567"]}},
			{"id":"fetch","type":"fetch_works","config":{"maxWorks":1,"maxFiles":100,"maxBytes":1000000}}
		],
		"edges":[{"id":"fetch_works","source":"works","sourceHandle":"works","target":"fetch","targetHandle":"works"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "allowUnknownSizes=false") {
		t.Fatalf("error = %v, want explicit unknown-size policy", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsAutomaticCircleRefresh(t *testing.T) {
	for _, mode := range []string{"incremental", "full"} {
		t.Run(mode, func(t *testing.T) {
			raw := `{
				"schemaVersion":2,
				"policy":{"requirePreview":false},
				"nodes":[
					{"id":"circle","type":"input_circle","config":{"value":"RG00001"}},
					{"id":"catalog","type":"circle_catalog","config":{"mode":"` + mode + `","maxWorks":100}}
				],
				"edges":[{"id":"catalog_circle","source":"circle","sourceHandle":"value","target":"catalog","targetHandle":"circle"}]
			}`
			if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "catalog refresh mode "+mode+" requires preview") {
				t.Fatalf("error = %v, want preview requirement", err)
			}
		})
	}
}

func TestValidateCustomWorkflowDefinitionAllowsPreviewedCircleRefresh(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"policy":{"requirePreview":true},
		"nodes":[
			{"id":"circle","type":"input_circle","config":{"value":"RG00001"}},
			{"id":"catalog","type":"circle_catalog","config":{"mode":"incremental","maxWorks":100}}
		],
		"edges":[{"id":"catalog_circle","source":"circle","sourceHandle":"value","target":"catalog","targetHandle":"circle"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err != nil {
		t.Fatalf("previewed refresh should be allowed: %v", err)
	}
}

func TestCheckedAddInt64RejectsInvalidSums(t *testing.T) {
	if sum, ok := checkedAddInt64(40, 2); !ok || sum != 42 {
		t.Fatalf("checkedAddInt64(40, 2) = %d, %v", sum, ok)
	}
	for _, values := range [][2]int64{{-1, 1}, {1, -1}, {math.MaxInt64, 1}} {
		if sum, ok := checkedAddInt64(values[0], values[1]); ok {
			t.Fatalf("checkedAddInt64(%d, %d) = %d, true; want rejection", values[0], values[1], sum)
		}
	}
}

func TestWorkflowInputWorkCandidatesUseValueHandle(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"inputs":[{"key":"works","label":"Works","type":"work_codes","required":true}],
		"nodes":[
			{"id":"input","type":"workflow_input","config":{"inputKey":"works"}},
			{"id":"filter","type":"filter_works","config":{"limit":10}}
		],
		"edges":[{"id":"works","source":"input","sourceHandle":"value","target":"filter","targetHandle":"works"}]
	}`
	graph, err := validateCustomWorkflowDefinition(raw)
	if err != nil {
		t.Fatalf("validate graph: %v", err)
	}
	execution, err := executeCustomInputNode(customWorkflowJobPayload{Inputs: map[string]any{"works": []any{"RJ01234567", "cc0001"}}}, graph, graph.NodesByID["input"])
	if err != nil {
		t.Fatalf("executeCustomInputNode() error = %v", err)
	}
	value, ok := execution.Outputs["value"]
	if !ok || value.Type != "work_candidates" || len(value.Candidates) != 2 || value.Candidates[0].Code != "RJ01234567" || value.Candidates[1].Code != "CC0001" {
		t.Fatalf("workflow input output = %+v", execution.Outputs)
	}
}

func TestMergedWorkflowNodeTypesOverrideLegacyContract(t *testing.T) {
	count := 0
	var availability workflowNodeTypeRecord
	for _, record := range mergedWorkflowNodeTypeRecords() {
		if record.Type == "check_source_availability" {
			count++
			availability = record
		}
	}
	if count != 1 {
		t.Fatalf("check_source_availability records = %d, want 1", count)
	}
	if !availability.Composite || len(availability.InputPorts) != 1 || len(availability.OutputPorts) != 3 {
		t.Fatalf("availability contract = %+v", availability)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsInvalidInputDefault(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"inputs":[{"key":"circle","label":"Circle","type":"circle_id","defaultValue":"not-a-circle"}],
		"nodes":[{"id":"input","type":"workflow_input","config":{"inputKey":"circle"}}],
		"edges":[]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "invalid default value") {
		t.Fatalf("error = %v, want invalid default value", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsInvalidConfigType(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"works","type":"input_work","config":{"codes":["RJ01234567"]}},
			{"id":"filter","type":"filter_works","config":{"limit":"10"}}
		],
		"edges":[{"id":"works","source":"works","sourceHandle":"works","target":"filter","targetHandle":"works"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "must be an integer") {
		t.Fatalf("error = %v, want integer config validation", err)
	}
}

func TestCustomWorkflowConfigSchemaDescribesSafeFetchBounds(t *testing.T) {
	var fetch workflowNodeTypeRecord
	for _, record := range mergedWorkflowNodeTypeRecords() {
		if record.Type == "fetch_works" {
			fetch = record
			break
		}
	}
	var schema struct {
		Properties map[string]map[string]any `json:"properties"`
	}
	if err := json.Unmarshal([]byte(fetch.ConfigSchema), &schema); err != nil {
		t.Fatalf("decode fetch schema: %v", err)
	}
	if schema.Properties["sourceId"]["minimum"] != float64(1) {
		t.Fatalf("sourceId schema = %#v", schema.Properties["sourceId"])
	}
	if _, hasInvalidDefault := schema.Properties["sourceId"]["default"]; hasInvalidDefault {
		t.Fatalf("sourceId schema must not default to an invalid source: %#v", schema.Properties["sourceId"])
	}
	if schema.Properties["allowUnknownSizes"]["default"] != false {
		t.Fatalf("allowUnknownSizes schema = %#v", schema.Properties["allowUnknownSizes"])
	}
}

func TestOptionalWorkflowInputExecutesAsEmptyValue(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"inputs":[{"key":"works","label":"Works","type":"work_codes","required":false}],
		"nodes":[{"id":"input","type":"workflow_input","config":{"inputKey":"works"}}],
		"edges":[]
	}`
	graph, err := validateCustomWorkflowDefinition(raw)
	if err != nil {
		t.Fatalf("validate graph: %v", err)
	}
	execution, err := executeCustomInputNode(customWorkflowJobPayload{Inputs: map[string]any{}}, graph, graph.NodesByID["input"])
	if err != nil {
		t.Fatalf("execute optional input: %v", err)
	}
	value, ok := execution.Outputs["value"]
	if !ok || value.Type != "work_candidates" || len(value.Candidates) != 0 {
		t.Fatalf("optional input output = %+v", execution.Outputs)
	}
}
