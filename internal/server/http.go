package server

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"
)

// Network I/O must never hold the state mutex: a slow uploader or downloader
// must not prevent another room from sending its heartbeat or live video.
func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(parts) == 4 && parts[0] == "api" && parts[1] == "rooms" && parts[3] == "stream" {
		s.serveStream(w, r, parts[2])
		return
	}
	if r.Method == http.MethodPost || r.Method == http.MethodPut {
		limit := int64(4096)
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
		if len(parts) == 4 && parts[0] == "api" && parts[1] == "rooms" {
			switch parts[3] {
			case "events":
				limit = 560 * 1024
			}
		}
		if r.Body == nil {
			r.Body = http.NoBody
		}
		body := http.MaxBytesReader(w, r.Body, limit)
		data, err := io.ReadAll(body)
		_ = body.Close()
		if err != nil {
			var large *http.MaxBytesError
			if errors.As(err, &large) {
				fail(w, 413, "Запрос слишком большой")
			} else {
				fail(w, 400, "Не удалось прочитать запрос")
			}
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(data))
	}
	response := &bufferedResponse{header: make(http.Header)}
	if r.Method == http.MethodPost && len(parts) == 4 && parts[0] == "api" && parts[1] == "rooms" && parts[3] == "events" {
		s.serveEvent(response, r, parts[2])
	} else {
		s.handleAPI(response, r)
	}
	response.flush(w)
}

type bufferedResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *bufferedResponse) Header() http.Header { return w.header }
func (w *bufferedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *bufferedResponse) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(data)
}
func (w *bufferedResponse) flush(destination http.ResponseWriter) {
	for key, values := range w.header {
		destination.Header()[key] = values
	}
	status := w.status
	if status == 0 {
		status = http.StatusOK
	}
	destination.WriteHeader(status)
	_, _ = w.body.WriteTo(destination)
}
