FROM golang:1.22 AS build

WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/kikoto ./cmd/kikoto

FROM gcr.io/distroless/static-debian12
WORKDIR /app
COPY --from=build /out/kikoto /app/kikoto
COPY migrations /app/migrations
EXPOSE 7659
ENTRYPOINT ["/app/kikoto"]
