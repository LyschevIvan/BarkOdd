FROM golang:1-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/barkodd ./cmd/barkodd

FROM alpine:3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache ca-certificates && addgroup -S barkodd && adduser -S -G barkodd barkodd && mkdir /data && chown barkodd:barkodd /data
WORKDIR /app
COPY --from=build /out/barkodd /app/barkodd
USER barkodd
ENV ADDR=0.0.0.0:8080 DATA_DIR=/data
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/app/barkodd"]
