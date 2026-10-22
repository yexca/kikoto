# Both build stages run on the builder's own platform: the web assets are
# platform-independent and Go cross-compiles, so a multi-platform build
# emulates only the runtime stage.
FROM --platform=$BUILDPLATFORM node:24.22.1@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a AS frontend-build

WORKDIR /src/frontend
COPY frontend/package*.json frontend/.npmrc ./
RUN npm ci --strict-allow-scripts
COPY VERSION /src/VERSION
COPY frontend/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26.10@sha256:fb456410ab4c979617acaf28c46b2b9fe60b11bcc3dc8ceea0eaeb3e7cd0f8a8 AS backend-build

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY VERSION /src/VERSION
COPY backend/ ./
ARG TARGETOS TARGETARCH
RUN VERSION="$(cat /src/VERSION)" \
  && CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH" go build \
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
