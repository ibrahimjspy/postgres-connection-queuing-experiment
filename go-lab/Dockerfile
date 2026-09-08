FROM golang:1.25-alpine AS build
WORKDIR /build
COPY go-lab/go.mod go-lab/go.sum ./
RUN go mod download
COPY go-lab/main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /go-event-loop-lab .

FROM alpine:3.22
COPY --from=build /go-event-loop-lab /usr/local/bin/go-event-loop-lab
USER nobody
EXPOSE 3000
CMD ["go-event-loop-lab"]
