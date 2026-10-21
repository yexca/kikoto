FROM golang:1.26.10@sha256:fb456410ab4c979617acaf28c46b2b9fe60b11bcc3dc8ceea0eaeb3e7cd0f8a8 AS build

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY VERSION /src/VERSION
COPY backend/ ./
RUN VERSION="$(cat /src/VERSION)" \
  && CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=${VERSION}" \
    -o /out/kikoto ./cmd/kikoto

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
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
