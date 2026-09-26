package httpapi

import (
	"encoding/json"
	"testing"
)

func TestLegacyWorkflowConversionRequiresExactPresetBehavior(t *testing.T) {
	spec, ok := presetWorkflowSpecByCode("circle_follow")
	if !ok {
		t.Fatal("circle preset missing")
	}
	inputs, err := normalizePresetWorkflowInputs(spec, map[string]any{"circleId": "RG12345", "metadata": true})
	if err != nil {
		t.Fatal(err)
	}
	graph := buildPresetWorkflowDefinition(spec, inputs, inputs.TagNameTemplate)
	encoded, err := json.Marshal(graph)
	if err != nil {
		t.Fatal(err)
	}
	item := legacyWorkflowSnapshot{ID: 1, Name: "Example workflow", DefinitionJSON: string(encoded),
		Triggers: []legacyWorkflowTrigger{{ID: 1, Type: "startup", Name: "On startup", Enabled: 1, Schedule: json.RawMessage(`{}`), Config: json.RawMessage(`{}`)}}}
	analysis := analyzeLegacyWorkflow(item)
	if !analysis.CanConvert || analysis.Preset != "circle_follow" {
		t.Fatalf("exact preset was not recognized: %+v", analysis)
	}
	graph.Policy.RequirePreview = nil
	encoded, err = json.Marshal(graph)
	if err != nil {
		t.Fatal(err)
	}
	item.DefinitionJSON = string(encoded)
	if changed := analyzeLegacyWorkflow(item); changed.CanConvert {
		t.Fatalf("different execution policy was accepted: %+v", changed)
	}
}
