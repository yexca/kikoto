package httpapi

import (
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestCustomStringValuesAcceptsDocumentedWorkCodeSeparators(t *testing.T) {
	rj := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	bj := testfixture.WorkCode(testfixture.PrefixBJ, 0)
	vj := testfixture.WorkCode(testfixture.PrefixVJ, 0)
	cc := testfixture.WorkCode(testfixture.PrefixCC, 0)
	values, err := customStringValues(fmt.Sprintf("%s; %s，%s；%s\n%s", rj, bj, vj, cc, rj))
	if err != nil {
		t.Fatal(err)
	}
	codes, err := normalizeCustomWorkCodes(values, 1000)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{rj, bj, vj, cc}
	if !reflect.DeepEqual(codes, want) {
		t.Fatalf("codes = %v, want %v", codes, want)
	}
}

func TestNormalizeCustomWorkCodesRejectsFourDigitCode(t *testing.T) {
	if _, err := normalizeCustomWorkCodes([]string{"RJ0000"}, 1000); err == nil {
		t.Fatal("normalizeCustomWorkCodes accepted a four-digit work code")
	}
}

func TestValidateCustomWorkflowDefinitionBuildsTypedDAG(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"stored","maxWorks":100},"position":{"x":0,"y":0}},
			{"id":"filter","type":"filter_works","config":{"limit":50},"position":{"x":200,"y":0}},
			{"id":"track","type":"track_works","config":{"sourceId":7,"maxWorks":50},"position":{"x":400,"y":0}},
			{"id":"tag","type":"tag_works","config":{"tagName":"followed"},"position":{"x":600,"y":0}}
		],
		"edges":[
			{"id":"e1","source":"catalog","sourceHandle":"works","target":"filter","targetHandle":"works"},
			{"id":"e2","source":"filter","sourceHandle":"accepted","target":"track","targetHandle":"works"},
			{"id":"e3","source":"track","sourceHandle":"completed","target":"tag","targetHandle":"works"}
		]
	}`
	graph, err := validateCustomWorkflowDefinition(raw)
	if err != nil {
		t.Fatalf("validateCustomWorkflowDefinition() error = %v", err)
	}
	want := []string{"catalog", "filter", "track", "tag"}
	if strings.Join(graph.TopologicalOrder, ",") != strings.Join(want, ",") {
		t.Fatalf("topological order = %v, want %v", graph.TopologicalOrder, want)
	}
	permissions := customWorkflowRequiredPermissions(graph)
	if strings.Join(permissions, ",") != "metadata:sync,tags:write,workflows:run" {
		t.Fatalf("required permissions = %v", permissions)
	}
}

func TestValidateCustomWorkflowDefinitionRequiresConnectedInputs(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"catalog","type":"circle_catalog","config":{"mode":"stored","maxWorks":10}},
			{"id":"filter","type":"filter_works","config":{"limit":10}}
		],
		"edges":[{"id":"e1","source":"catalog","sourceHandle":"works","target":"filter","targetHandle":"works"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "required input is not connected: catalog.circle") {
		t.Fatalf("error = %v, want unconnected required input", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsPortMismatch(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"stored","maxWorks":10}},
			{"id":"tag","type":"tag_works","config":{"tagName":"followed"}}
		],
		"edges":[{"id":"bad","source":"catalog","sourceHandle":"works","target":"tag","targetHandle":"works"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "incompatible edge") {
		t.Fatalf("error = %v, want incompatible edge", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsCycle(t *testing.T) {
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
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "acyclic") {
		t.Fatalf("error = %v, want acyclic validation", err)
	}
}

func TestValidateCustomWorkflowDefinitionRequiresExplicitAutomaticFetchBounds(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"policy":{"requirePreview":false},
		"nodes":[
			{"id":"works","type":"series_catalog","config":{"seriesId":"SRI0000001","maxWorks":10}},
			{"id":"fetch","type":"fetch_works","config":{"maxWorks":1,"maxFiles":100,"maxBytes":1000000,"minFreeBytes":1000000}}
		],
		"edges":[{"id":"fetch_works","source":"works","sourceHandle":"works","target":"fetch","targetHandle":"works"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "allowUnknownSizes=false") {
		t.Fatalf("error = %v, want explicit unknown-size policy", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsNegativeDiskReserve(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"policy":{"requirePreview":true},
		"nodes":[
			{"id":"works","type":"series_catalog","config":{"seriesId":"SRI0000001","maxWorks":10}},
			{"id":"fetch","type":"fetch_works","config":{"minFreeBytes":-1}}
		],
		"edges":[{"id":"fetch_works","source":"works","sourceHandle":"works","target":"fetch","targetHandle":"works"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "minFreeBytes between 1") {
		t.Fatalf("error = %v, want positive minFreeBytes requirement", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsAutomaticCircleRefresh(t *testing.T) {
	for _, mode := range []string{"incremental", "full"} {
		t.Run(mode, func(t *testing.T) {
			raw := `{
				"schemaVersion":2,
				"policy":{"requirePreview":false},
				"nodes":[{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"` + mode + `","maxWorks":100}}],
				"edges":[]
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
		"nodes":[{"id":"catalog","type":"circle_catalog","config":{"circleId":"RG00001","mode":"incremental","maxWorks":100}}],
		"edges":[]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err != nil {
		t.Fatalf("previewed refresh should be allowed: %v", err)
	}
}

func TestValidateCustomWorkflowDefinitionRejectsRemovedNodeKinds(t *testing.T) {
	for _, kind := range []string{"workflow_input", "input_work", "template_text", "subworkflow", "check_source_availability", "provider_popular_works"} {
		raw := `{"schemaVersion":2,"nodes":[{"id":"node","type":"` + kind + `","config":{}}],"edges":[]}`
		if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "unsupported executable node type: "+kind) {
			t.Fatalf("%s: error = %v, want unsupported node type", kind, err)
		}
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

func TestValidateCustomWorkflowDefinitionRejectsInvalidConfigType(t *testing.T) {
	raw := `{
		"schemaVersion":2,
		"nodes":[
			{"id":"works","type":"series_catalog","config":{"seriesId":"SRI0000001","maxWorks":10}},
			{"id":"filter","type":"filter_works","config":{"limit":"10"}}
		],
		"edges":[{"id":"works","source":"works","sourceHandle":"works","target":"filter","targetHandle":"works"}]
	}`
	if _, err := validateCustomWorkflowDefinition(raw); err == nil || !strings.Contains(err.Error(), "must be an integer") {
		t.Fatalf("error = %v, want integer config validation", err)
	}
}
