package server

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Metadata is committed before photos are removed. The persisted pending bit
// makes cleanup restartable without retaining an unbounded list of filenames.
func emptiedHistory(current *room) room {
	updated := *current
	updated.Events = []storedEvent{}
	updated.LastNoiseAt = nil
	updated.PhotoCleanupPending = true
	updated.HistoryVersion++
	return updated
}

// The caller holds s.mu. Manual clear preserves the source and allows a new photo.
func (s *Server) clearHistory(w http.ResponseWriter, current *room) {
	updated := emptiedHistory(current)
	now := s.now()
	updated.HistoryClearedAt = &now
	if err := s.save(&updated); err != nil {
		fail(w, 500, "Не удалось очистить историю; события сохранены")
		return
	}
	*current = updated
	s.retryHistoryCleanup(current)
	writeJSON(w, 200, map[string]any{"ok": true, "cleanupPending": current.PhotoCleanupPending, "historyVersion": current.HistoryVersion})
}

func (s *Server) retryHistoryCleanup(current *room) {
	if !current.PhotoCleanupPending {
		return
	}
	if err := s.finishHistoryCleanup(current); err != nil {
		log.Printf("BarkOdd history photo cleanup pending for room %s: %v", current.ID, err)
	}
}

func (s *Server) finishHistoryCleanup(current *room) error {
	directory := filepath.Join(s.config.DataDir, "photos")
	files, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	wanted := make(map[string]bool, len(current.Events))
	for _, event := range current.Events {
		if event.PhotoFile != "" {
			wanted[event.PhotoFile] = true
		}
	}
	var failures []error
	for _, file := range files {
		name := file.Name()
		if !strings.HasPrefix(name, current.ID+"_") || !photoName.MatchString(name) || wanted[name] {
			continue
		}
		if err := os.Remove(filepath.Join(directory, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	if len(failures) != 0 {
		return errors.Join(failures...)
	}
	updated := *current
	updated.PhotoCleanupPending = false
	if err := s.save(&updated); err != nil {
		return err
	}
	*current = updated
	return nil
}

func clearedNoise(current *room, body *eventPayload) bool {
	if body.HistoryVersion != nil {
		return *body.HistoryVersion != current.HistoryVersion
	}
	return current.HistoryClearedAt != nil && body.DetectedAt != nil && !body.detectedAt.After(*current.HistoryClearedAt)
}

func clearedPhoto(current *room, body *eventPayload) bool {
	if body.HistoryVersion != nil && *body.HistoryVersion == current.HistoryVersion {
		return false
	}
	return current.HistoryClearedAt != nil && body.Photo != "" && body.PhotoAt != nil && !body.photoAt.After(*current.HistoryClearedAt)
}

func discardEvent(w http.ResponseWriter, current *room) {
	writeJSON(w, 200, map[string]any{"discarded": true, "historyVersion": current.HistoryVersion, "photoStatus": "discarded"})
}
