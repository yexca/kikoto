FROM node:22 AS frontend-build

WORKDIR /src/frontend
COPY VERSION /src/VERSION
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM golang:1.22 AS backend-build

WORKDIR /src/backend
COPY VERSION /src/VERSION
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN VERSION="$(cat /src/VERSION)" \
  && CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=${VERSION}" \
    -o /out/kikoto ./cmd/kikoto

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-build /out/kikoto /app/kikoto
COPY backend/migrations /app/migrations
COPY --from=frontend-build /src/frontend/dist /app/static
COPY LICENSE /app/LICENSE

ENV KIKOTO_HTTP_ADDR=0.0.0.0:7659
ENV KIKOTO_STATIC_DIR=/app/static

EXPOSE 7659
ENTRYPOINT ["/app/kikoto"]
