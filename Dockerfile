FROM node:24.19.0@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584 AS frontend-build

WORKDIR /src/frontend
COPY VERSION /src/VERSION
COPY frontend/package*.json frontend/.npmrc ./
RUN npm ci --strict-allow-scripts
COPY frontend/ ./
RUN npm run build

FROM golang:1.26.6@sha256:0d1d3a794be25f809dd2cb3160d8c73276c4056a9f8242a138e908ddeee7b6b6 AS backend-build

WORKDIR /src/backend
COPY VERSION /src/VERSION
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN VERSION="$(cat /src/VERSION)" \
  && CGO_ENABLED=0 GOOS=linux go build \
    -ldflags "-X github.com/yexca/kikoto/backend/internal/buildinfo.Version=${VERSION}" \
    -o /out/kikoto ./cmd/kikoto

FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates=20230311+deb12u1 \
    ffmpeg=7:5.1.9-0+deb12u1 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=backend-build /out/kikoto /app/kikoto
COPY --from=frontend-build /src/frontend/dist /app/static
COPY LICENSE /app/LICENSE

ENV KIKOTO_HTTP_ADDR=0.0.0.0:7659
ENV KIKOTO_STATIC_DIR=/app/static

EXPOSE 7659
ENTRYPOINT ["/app/kikoto"]
