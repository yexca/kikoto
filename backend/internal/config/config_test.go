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

func TestLoadDefaultsToProductionMode(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeMode() != ModeProduction {
		t.Fatalf("mode = %q, want production", cfg.RuntimeMode())
	}
}

func TestLoadReadsDemoMode(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "demo")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.IsDemo() {
		t.Fatal("Load() did not enable demo mode")
	}
}

func TestLoadRejectsUnknownMode(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "staging")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted an unknown runtime mode")
	}
}
