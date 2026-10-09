FROM golang:1.26.9@sha256:f1f0bcc2c524a3ced375fcb4d1ecb7aa371aa7070e112599aaca45cc02d0101b AS build

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY VERSION /src/VERSION
COPY backend/ ./
RUN VERSION="$(cat /src/VERSION)" \
  && CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=${VERSION}" \
    -o /out/kikoto ./cmd/kikoto

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
# Debian packages float within the digest-pinned release; see the root Dockerfile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/kikoto /app/kikoto
COPY LICENSE /app/LICENSE
EXPOSE 7659
ENTRYPOINT ["/app/kikoto"]
