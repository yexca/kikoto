package httpapi

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestGraphStringValuesAcceptsDocumentedWorkCodeSeparators(t *testing.T) {
	rj := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	bj := testfixture.WorkCode(testfixture.PrefixBJ, 0)
	vj := testfixture.WorkCode(testfixture.PrefixVJ, 0)
	cc := testfixture.WorkCode(testfixture.PrefixCC, 0)
	values, err := graphStringValues(fmt.Sprintf("%s; %s，%s；%s\n%s", rj, bj, vj, cc, rj))
	if err != nil {
		t.Fatal(err)
	}
	codes, err := normalizeGraphWorkCodes(values, 1000)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{rj, bj, vj, cc}
	if !reflect.DeepEqual(codes, want) {
		t.Fatalf("codes = %v, want %v", codes, want)
	}
}

func TestNormalizeGraphWorkCodesRejectsFourDigitCode(t *testing.T) {
	if _, err := normalizeGraphWorkCodes([]string{"RJ0000"}, 1000); err == nil {
		t.Fatal("normalizeCustomWorkCodes accepted a four-digit work code")
	}
}

func TestValidateWorkflowGraphDefinitionBuildsTypedDAG(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"stored","maxWorks":100},"position":{"x":0,"y":0}},
			{"id":"filter","type":"filter_works","config":{"limit":50},"position":{"x":200,"y":0}},
			{"id":"action","type":"metadata_sync","config":{"maxWorks":50},"position":{"x":400,"y":0}},
			{"id":"tag","type":"tag_works","config":{"tagName":"followed"},"position":{"x":600,"y":0}}
		],
		"edges":[
			{"id":"e1","source":"catalog","sourceHandle":"works","target":"filter","targetHandle":"works"},
			{"id":"e2","source":"filter","sourceHandle":"accepted","target":"action","targetHandle":"works"},
			{"id":"e3","source":"action","sourceHandle":"completed","target":"tag","targetHandle":"works"}
		]
	}`
	graph, err := validateWorkflowGraphDefinition(raw)
	if err != nil {
		t.Fatalf("validateCustomWorkflowDefinition() error = %v", err)
	}
	want := []string{"catalog", "filter", "action", "tag"}
	if strings.Join(graph.TopologicalOrder, ",") != strings.Join(want, ",") {
		t.Fatalf("topological order = %v, want %v", graph.TopologicalOrder, want)
	}
	permissions := workflowGraphRequiredPermissions(graph)
	if strings.Join(permissions, ",") != "metadata:sync,tags:write,workflows:run" {
		t.Fatalf("required permissions = %v", permissions)
	}
}

func TestValidateWorkflowGraphDefinitionRequiresConnectedInputs(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"catalog","type":"circle_catalog","config":{"mode":"stored","maxWorks":10}},
			{"id":"filter","type":"filter_works","config":{"limit":10}}
		],
		"edges":[{"id":"e1","source":"catalog","sourceHandle":"works","target":"filter","targetHandle":"works"}]
	}`
	if _, err := validateWorkflowGraphDefinition(raw); err == nil || !strings.Contains(err.Error(), "required input is not connected: catalog.circle") {
		t.Fatalf("error = %v, want unconnected required input", err)
	}
}

func TestValidateWorkflowGraphDefinitionRejectsPortMismatch(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"stored","maxWorks":10}},
			{"id":"tag","type":"tag_works","config":{"tagName":"followed"}}
		],
		"edges":[{"id":"bad","source":"catalog","sourceHandle":"works","target":"tag","targetHandle":"works"}]
	}`
	if _, err := validateWorkflowGraphDefinition(raw); err == nil || !strings.Contains(err.Error(), "incompatible edge") {
		t.Fatalf("error = %v, want incompatible edge", err)
	}
}

func TestValidateWorkflowGraphDefinitionRejectsCycle(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"first","type":"filter_works","config":{"limit":10}},
			{"id":"second","type":"filter_works","config":{"limit":10}}
		],
		"edges":[
			{"id":"one","source":"first","sourceHandle":"accepted","target":"second","targetHandle":"works"},
			{"id":"two","source":"second","sourceHandle":"accepted","target":"first","targetHandle":"works"}
		]
	}`
	if _, err := validateWorkflowGraphDefinition(raw); err == nil || !strings.Contains(err.Error(), "acyclic") {
		t.Fatalf("error = %v, want acyclic validation", err)
	}
}

func TestValidateWorkflowGraphDefinitionRejectsAutomaticCircleRefresh(t *testing.T) {
	for _, mode := range []string{"incremental", "full"} {
		t.Run(mode, func(t *testing.T) {
			raw := `{
				"schemaVersion":2,
				"policy":{"requirePreview":false},
				"nodes":[{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"` + mode + `","maxWorks":100}}],
				"edges":[]
			}`
			if _, err := validateWorkflowGraphDefinition(raw); err == nil || !strings.Contains(err.Error(), "catalog refresh mode "+mode+" requires preview") {
				t.Fatalf("error = %v, want preview requirement", err)
			}
		})
	}
}

func TestValidateWorkflowGraphDefinitionAllowsPreviewedCircleRefresh(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"policy":{"requirePreview":true},
		"nodes":[{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"incremental","maxWorks":100}}],
		"edges":[]
	}`
	if _, err := validateWorkflowGraphDefinition(raw); err != nil {
		t.Fatalf("previewed refresh should be allowed: %v", err)
	}
}

func TestValidateWorkflowGraphDefinitionRejectsRemovedNodeKinds(t *testing.T) {
	for _, kind := range []string{"workflow_input", "input_work", "template_text", "subworkflow", "check_source_availability", "provider_popular_works", "track_works", "fetch_works"} {
		raw := `{"schemaVersion":2,"nodes":[{"id":"node","type":"` + kind + `","config":{}}],"edges":[]}`
		if _, err := validateWorkflowGraphDefinition(raw); err == nil || !strings.Contains(err.Error(), "unsupported executable node type: "+kind) {
			t.Fatalf("%s: error = %v, want unsupported node type", kind, err)
		}
	}
}

func TestValidateWorkflowGraphDefinitionRejectsInvalidConfigType(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"works","type":"series_catalog","config":{"seriesId":"SRI0000001","maxWorks":10}},
			{"id":"filter","type":"filter_works","config":{"limit":"10"}}
		],
		"edges":[{"id":"works","source":"works","sourceHandle":"works","target":"filter","targetHandle":"works"}]
	}`
	if _, err := validateWorkflowGraphDefinition(raw); err == nil || !strings.Contains(err.Error(), "must be an integer") {
		t.Fatalf("error = %v, want integer config validation", err)
	}
}
