FROM node:24.19.0@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584 AS frontend-build

WORKDIR /src/frontend
COPY frontend/package*.json frontend/.npmrc ./
RUN npm ci --strict-allow-scripts
COPY VERSION /src/VERSION
COPY frontend/ ./
RUN npm run build

FROM golang:1.26.9@sha256:f1f0bcc2c524a3ced375fcb4d1ecb7aa371aa7070e112599aaca45cc02d0101b AS backend-build

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

# Debian packages float within the digest-pinned release so each build takes
# current security updates; the published image SBOM records exact versions.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-build /out/kikoto /app/kikoto
COPY --from=frontend-build /src/frontend/dist /app/static
COPY LICENSE /app/LICENSE

ENV KIKOTO_HTTP_ADDR=0.0.0.0:7659
ENV KIKOTO_STATIC_DIR=/app/static

EXPOSE 7659
ENTRYPOINT ["/app/kikoto"]
