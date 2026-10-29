FROM golang:1.26-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
COPY internal ./internal
COPY src/web ./src/web
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/zcode2api .

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/zcode2api /usr/local/bin/zcode2api
ENV ZCODE2API_DATA_DIR=/app/data \
    ZCODE2API_HOST=0.0.0.0 \
    ZCODE2API_WEB_PORT=6789 \
    ZCODE2API_GATEWAY_PORT=6780
VOLUME /app/data
EXPOSE 6789 6780
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["zcode2api", "--healthcheck", "auto"]
CMD ["zcode2api", "--root", "/app"]
