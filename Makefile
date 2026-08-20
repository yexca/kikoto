.PHONY: backend-verify backend-vuln backend-test backend-test-container backend-coverage backend-vet backend-race backend-build backend-run frontend-install frontend-dev frontend-build frontend-coverage frontend-format frontend-lint frontend-docs frontend-audit frontend-audit-signatures frontend-playwright-install frontend-e2e-smoke frontend-e2e android-build docker-build docker-up docker-down docker-status docker-logs smoke smoke-api smoke-up smoke-down smoke-status smoke-logs sensitive-check sensitive-check-test privacy-check ci-style ci-backend ci-frontend ci-local ci

GO ?= go
NPM ?= npm
NPX ?= npx
NODE ?= node
DOCKER ?= docker
DOCKER_IMAGE ?= kikoto:dev
GO_IMAGE ?= golang:1.26.6@sha256:0d1d3a794be25f809dd2cb3160d8c73276c4056a9f8242a138e908ddeee7b6b6
DOCKER_COMPOSE_DEV = $(DOCKER) compose -f docker-compose.dev.yml
SMOKE_COMPOSE_PROJECT := kikoto-smoke
SMOKE_CONFIG_DIR := ./.smoke/config
SMOKE_CACHE_DIR := ./.smoke/cache
SMOKE_DATA_DIR := ./.smoke/data
SMOKE_BACKEND_PORT := 17659
SMOKE_FRONTEND_PORT := 17655
SMOKE_HEALTH_URL := http://127.0.0.1:$(SMOKE_BACKEND_PORT)/health
SMOKE_BASE_URL := http://127.0.0.1:$(SMOKE_FRONTEND_PORT)
SMOKE_TARGETS := smoke smoke-api smoke-up smoke-down smoke-status smoke-logs
DOCKER_COMPOSE_SMOKE = $(DOCKER) compose -p $(SMOKE_COMPOSE_PROJECT) -f docker-compose.dev.yml
PLAYWRIGHT_INSTALL_ARGS ?= chromium

# Smoke always runs against disposable mounts, non-development ports, and fixed runtime inputs.
$(SMOKE_TARGETS): export KIKOTO_MODE := development
$(SMOKE_TARGETS): export KIKOTO_ROOT_USERNAME := root
$(SMOKE_TARGETS): export KIKOTO_ROOT_PASSWORD := change-me
$(SMOKE_TARGETS): export KIKOTO_HTTP_ADDR := 0.0.0.0:7659
$(SMOKE_TARGETS): export KIKOTO_DB_PATH := /config/kikoto.db
$(SMOKE_TARGETS): export KIKOTO_DATA_ROOT := /data
$(SMOKE_TARGETS): export KIKOTO_CACHE_ROOT := /cache
$(SMOKE_TARGETS): export KIKOTO_LOCAL_SCAN_DEPTH := 3
$(SMOKE_TARGETS): export KIKOTO_SESSION_COOKIE_SECURE := false
$(SMOKE_TARGETS): export KIKOTO_REMOTE_SOURCES_ENABLED := false
$(SMOKE_TARGETS): export KIKOTO_DEV_CONFIG_DIR := $(SMOKE_CONFIG_DIR)
$(SMOKE_TARGETS): export KIKOTO_DEV_CACHE_DIR := $(SMOKE_CACHE_DIR)
$(SMOKE_TARGETS): export KIKOTO_DEV_DATA_DIR := $(SMOKE_DATA_DIR)
$(SMOKE_TARGETS): export KIKOTO_DEV_BACKEND_PORT := $(SMOKE_BACKEND_PORT)
$(SMOKE_TARGETS): export KIKOTO_DEV_FRONTEND_PORT := $(SMOKE_FRONTEND_PORT)
$(SMOKE_TARGETS): export KIKOTO_SMOKE_HEALTH_URL := $(SMOKE_HEALTH_URL)
$(SMOKE_TARGETS): export PLAYWRIGHT_BASE_URL := $(SMOKE_BASE_URL)

ifeq ($(CI),true)
PLAYWRIGHT_INSTALL_ARGS := --with-deps chromium
endif

ifeq ($(OS),Windows_NT)
APP_VERSION := $(shell powershell -NoProfile -Command "(Get-Content -Raw VERSION).Trim()")
else
APP_VERSION := $(shell tr -d '\r\n' < VERSION)
endif

backend-verify:
	cd backend && $(GO) mod verify

backend-vuln:
	cd backend && $(GO) run golang.org/x/vuln/cmd/govulncheck@v1.7.0 ./...

backend-test:
	cd backend && $(GO) test ./...

backend-test-container:
	$(DOCKER) run --rm -v "$(CURDIR)/backend:/src" -w /src $(GO_IMAGE) $(GO) test ./...

backend-coverage:
	cd backend && $(GO) test -count=1 -covermode atomic -coverpkg ./... -coverprofile coverage.out ./...
	cd backend && $(GO) tool cover -func coverage.out

backend-vet:
	cd backend && $(GO) vet ./...

backend-race:
	cd backend && $(GO) test -race ./...

backend-build:
	cd backend && $(GO) build -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=$(APP_VERSION)" -o bin/kikoto ./cmd/kikoto

backend-run:
	cd backend && $(GO) run -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=$(APP_VERSION)" ./cmd/kikoto

frontend-install:
	cd frontend && $(NPM) ci --strict-allow-scripts

frontend-dev: frontend-install
	cd frontend && $(NPM) run dev

frontend-build: frontend-install
	cd frontend && $(NPM) run build

frontend-coverage: frontend-install
	cd frontend && $(NPM) run test:unit:coverage

frontend-format: frontend-install
	cd frontend && $(NPM) run format:check

frontend-lint: frontend-install
	cd frontend && $(NPM) run lint

frontend-docs: frontend-install
	cd frontend && $(NPM) run docs:check-links

frontend-audit: frontend-install
	cd frontend && $(NPM) audit --audit-level=moderate

frontend-audit-signatures: frontend-install
	cd frontend && $(NPM) audit signatures

frontend-playwright-install: frontend-install
	cd frontend && $(NPX) playwright install $(PLAYWRIGHT_INSTALL_ARGS)

frontend-e2e-smoke: frontend-playwright-install
	cd frontend && $(NPM) run test:e2e:smoke

frontend-e2e: frontend-playwright-install
	cd frontend && $(NPM) run test:e2e

ifeq ($(OS),Windows_NT)
android-build: frontend-install
	cd frontend && $(NPM) run cap:sync
	cd frontend/android && gradlew.bat --dependency-verification strict assembleDebug
else
android-build: frontend-install
	cd frontend && $(NPM) run cap:sync
	cd frontend/android && chmod +x ./gradlew && ./gradlew --dependency-verification strict assembleDebug
endif

docker-build:
	$(DOCKER) build -t $(DOCKER_IMAGE) .

docker-up:
	$(DOCKER_COMPOSE_DEV) up -d --build

docker-down:
	$(DOCKER_COMPOSE_DEV) down

docker-status:
	$(DOCKER_COMPOSE_DEV) ps

docker-logs:
	$(DOCKER_COMPOSE_DEV) logs --no-color backend

smoke:
	$(NODE) scripts/smoke.mjs run

smoke-api:
	$(NODE) scripts/smoke.mjs wait-for-health

smoke-up:
	$(DOCKER_COMPOSE_SMOKE) up -d --build

smoke-down:
	$(DOCKER_COMPOSE_SMOKE) down --volumes

smoke-status:
	$(DOCKER_COMPOSE_SMOKE) ps

smoke-logs:
	$(DOCKER_COMPOSE_SMOKE) logs --no-color backend

sensitive-check:
	$(NODE) scripts/check-sensitive.mjs

sensitive-check-test:
	$(NODE) --test scripts/check-sensitive.test.mjs

privacy-check: sensitive-check

ci-style: frontend-format frontend-lint frontend-docs sensitive-check-test

ci-backend: backend-verify backend-vuln backend-test backend-coverage backend-vet backend-race

ci-frontend: frontend-audit frontend-audit-signatures frontend-coverage frontend-build

# ci-local follows every GitHub Actions validation phase available without an Android SDK.
ci-local: DOCKER_IMAGE := kikoto:ci
ci-local: ci-style ci-backend ci-frontend smoke frontend-e2e docker-build

ci: ci-local android-build
