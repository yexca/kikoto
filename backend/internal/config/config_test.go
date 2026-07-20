package config

import (
	"reflect"
	"testing"
)

func TestEnvListNormalizesAndDeduplicatesOrigins(t *testing.T) {
	t.Setenv("KIKOTO_ALLOWED_ORIGINS", " https://app.example/ ,http://localhost:5173,https://app.example ")
	want := []string{"https://app.example", "http://localhost:5173"}
	if got := envList("KIKOTO_ALLOWED_ORIGINS"); !reflect.DeepEqual(got, want) {
		t.Fatalf("envList() = %#v, want %#v", got, want)
	}
}

func TestLoadReadsDemoMode(t *testing.T) {
	t.Setenv("KIKOTO_DEMO_MODE", "true")
	if cfg := Load(); !cfg.DemoMode {
		t.Fatal("Load() did not enable demo mode")
	}
}
