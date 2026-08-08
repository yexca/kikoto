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
	t.Setenv("KIKOTO_ROOT_PASSWORD", "production-root-password")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeMode() != ModeProduction {
		t.Fatalf("mode = %q, want production", cfg.RuntimeMode())
	}
}

func TestLoadDefaultsLocalScanDepthToThree(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "development")
	t.Setenv("KIKOTO_LOCAL_SCAN_DEPTH", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalScanDepth != 3 {
		t.Fatalf("local scan depth = %d, want 3", cfg.LocalScanDepth)
	}
}

func TestLoadRequiresExplicitProductionRootPassword(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "production")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted a missing production root password")
	}

	t.Setenv("KIKOTO_ROOT_PASSWORD", "change-me")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted the default production root password")
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
