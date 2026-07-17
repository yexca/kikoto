.PHONY: backend-test backend-build backend-run frontend-dev frontend-build docker-build docker-up docker-down smoke smoke-api

backend-test:
	docker run --rm -v "$$(pwd)/backend:/src" -w /src golang:1.22 go test ./...

backend-build:
	cd backend && go build -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=$$(cat ../VERSION)" -o bin/kikoto ./cmd/kikoto

backend-run:
	cd backend && go run -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=$$(cat ../VERSION)" ./cmd/kikoto

frontend-dev:
	cd frontend && npm install && npm run dev

frontend-build:
	cd frontend && npm install && npm run build

docker-build:
	docker build -t kikoto:dev .

docker-up:
	docker compose -f docker-compose.dev.yml up --build

docker-down:
	docker compose down

smoke-api:
	powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-api.ps1

smoke: frontend-build backend-test docker-build smoke-api
