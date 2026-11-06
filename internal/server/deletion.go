package server

import (
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// A durable marker keeps deletion restartable if photo cleanup is interrupted.
// The caller holds s.mu; failure to mark deletion leaves the room usable.
func (s *Server) deleteRoom(w http.ResponseWriter, current *room) {
	path := filepath.Join(s.config.DataDir, current.ID)
	if err := os.Rename(path+".json", path+".deleted"); err != nil {
		fail(w, 500, "Не удалось удалить комнату; доступ сохранён")
		return
	}
	if dir, err := os.Open(s.config.DataDir); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	delete(s.rooms, current.ID)
	for c := range s.streams {
		if c.roomID == current.ID {
			s.closeStreamLocked(c, streamClose{code: 1008, status: 404, message: "Комната удалена"})
		}
	}
	if err := s.finishRoomDeletion(current.ID); err != nil {
		log.Printf("BarkOdd photo deletion pending for room %s: %v", current.ID, err)
		writeJSON(w, 202, map[string]bool{"deleted": true, "cleanupPending": true})
		return
	}
	writeJSON(w, 200, map[string]bool{"deleted": true, "cleanupPending": false})
}

func (s *Server) finishRoomDeletion(id string) error {
	directory := filepath.Join(s.config.DataDir, "photos")
	files, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	var failures []error
	for _, file := range files {
		if !strings.HasPrefix(file.Name(), id+"_") || !photoName.MatchString(file.Name()) {
			continue
		}
		path := filepath.Join(directory, file.Name())
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	if len(failures) != 0 {
		return errors.Join(failures...)
	}
	err = os.Remove(filepath.Join(s.config.DataDir, id+".deleted"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func (s *Server) retryRoomDeletions() {
	markers, err := os.ReadDir(s.config.DataDir)
	if err != nil {
		log.Printf("BarkOdd deletion cleanup: %v", err)
		return
	}
	for _, marker := range markers {
		if !strings.HasSuffix(marker.Name(), ".deleted") {
			continue
		}
		id := strings.TrimSuffix(marker.Name(), ".deleted")
		if !storageID.MatchString(id) {
			continue
		}
		if err := s.finishRoomDeletion(id); err != nil {
			log.Printf("BarkOdd deletion cleanup for %s: %v", id, err)
		}
	}
}
