package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"barkodd/internal/server"
	"barkodd/web"
)

type options struct {
	addr, cert, key string
	server          server.Config
}

func readOptions(getenv func(string) string) (options, error) {
	value := func(key, fallback string) string {
		if s := strings.TrimSpace(getenv(key)); s != "" {
			return s
		}
		return fallback
	}
	o := options{addr: value("ADDR", "127.0.0.1:8080"), cert: getenv("TLS_CERT_FILE"), key: getenv("TLS_KEY_FILE")}
	if (o.cert == "") != (o.key == "") {
		return o, errors.New("TLS_CERT_FILE и TLS_KEY_FILE необходимо указывать вместе")
	}
	list := func(key string) []string {
		raw := strings.TrimSpace(getenv(key))
		if raw == "" {
			return nil
		}
		if key == "STUN_URLS" && raw == "none" {
			return []string{}
		}
		items := strings.Split(raw, ",")
		for i := range items {
			items[i] = strings.TrimSpace(items[i])
		}
		return items
	}
	o.server = server.Config{
		RoomCreationKey: getenv("ROOM_CREATION_KEY"), DataDir: value("DATA_DIR", "data"), PublicURL: getenv("PUBLIC_URL"),
		MediaTransport: value("MEDIA_TRANSPORT", "websocket"),
		STUNURLs:       list("STUN_URLS"), TURNURLs: list("TURN_URLS"),
		TURNSecret: getenv("TURN_SECRET"), TURNUsername: getenv("TURN_USERNAME"), TURNPassword: getenv("TURN_PASSWORD"),
	}
	return o, nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	o, err := readOptions(os.Getenv)
	if err != nil {
		return err
	}
	api, err := server.New(o.server)
	if err != nil {
		return err
	}
	defer api.Close()
	assets, err := fs.Sub(web.Files, ".")
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("/api/", api.Handler())
	mux.Handle("/healthz", api.Handler())
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Only embedded public files are served; no source/config/data directories.
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Path == "/" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		http.FileServerFS(assets).ServeHTTP(w, r)
	}))
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
		mux.ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: o.addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() {
		if o.cert != "" {
			done <- srv.ListenAndServeTLS(o.cert, o.key)
		} else {
			done <- srv.ListenAndServe()
		}
	}()
	protocol := "http"
	if o.cert != "" {
		protocol = "https"
	}
	log.Printf("BarkOdd: %s://%s · данные: %s", protocol, o.addr, o.server.DataDir)
	select {
	case err := <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("HTTP server: %w", err)
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdown)
	}
}
