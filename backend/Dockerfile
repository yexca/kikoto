FROM golang:1.22 AS build

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
COPY --from=build /out/kikoto /app/kikoto
COPY backend/migrations /app/migrations
COPY LICENSE /app/LICENSE
EXPOSE 7659
ENTRYPOINT ["/app/kikoto"]
