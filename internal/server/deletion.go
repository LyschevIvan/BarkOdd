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
	if err := s.markCameraDeleted(current.ID); err != nil {
		fail(w, 500, "Не удалось удалить камеру; доступ сохранён")
		return
	}
	s.removeCameraLocked(current.ID)
	err := s.finishRoomDeletion(current.ID)
	if err != nil {
		log.Printf("BarkOdd photo deletion pending for camera %s: %v", current.ID, err)
	}
	writeDeletionResult(w, err != nil)
}

func (s *Server) markCameraDeleted(id string) error {
	path := filepath.Join(s.config.DataDir, id)
	if err := os.Rename(path+".json", path+".deleted"); err != nil {
		return err
	}
	syncDirectory(s.config.DataDir)
	return nil
}

func (s *Server) removeCameraLocked(id string) {
	delete(s.rooms, id)
	for c := range s.streams {
		if c.roomID == id {
			s.closeStreamLocked(c, streamClose{code: 1008, status: 404, message: "Камера удалена"})
		}
	}
}

func writeDeletionResult(w http.ResponseWriter, cleanupPending bool) {
	status := http.StatusOK
	if cleanupPending {
		status = http.StatusAccepted
	}
	writeJSON(w, status, map[string]bool{"deleted": true, "cleanupPending": cleanupPending})
}

// Renaming the group record commits deletion for every camera at once.
// Startup suppresses cameras referencing that marker until cleanup succeeds.
func (s *Server) deleteGroupLocked(w http.ResponseWriter, current *group) {
	marker := s.groupPath(current.ID, ".deleted")
	if err := os.Rename(s.groupPath(current.ID, ".json"), marker); err != nil {
		fail(w, 500, "Не удалось удалить комнату; доступ сохранён")
		return
	}
	syncDirectory(filepath.Dir(marker))
	delete(s.groups, current.ID)
	s.deletedGroups[current.ID] = nil
	for _, camera := range s.camerasInGroupLocked(current.ID) {
		s.removeCameraLocked(camera.ID)
		s.deletedGroups[current.ID] = append(s.deletedGroups[current.ID], camera.ID)
	}
	s.finishGroupDeletion(current.ID)
	_, pending := s.deletedGroups[current.ID]
	writeDeletionResult(w, pending)
}

func (s *Server) finishGroupDeletion(groupID string) {
	cameras := s.deletedGroups[groupID]
	pending := cameras[:0]
	for _, id := range cameras {
		if err := s.markCameraDeleted(id); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("BarkOdd group deletion pending for camera %s: %v", id, err)
			pending = append(pending, id)
			continue
		}
		if err := s.finishRoomDeletion(id); err != nil {
			log.Printf("BarkOdd group photo deletion pending for camera %s: %v", id, err)
			pending = append(pending, id)
		}
	}
	s.deletedGroups[groupID] = pending
	if len(pending) > 0 {
		return
	}
	marker := s.groupPath(groupID, ".deleted")
	if err := os.Remove(marker); err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("BarkOdd group deletion pending for %s: %v", groupID, err)
		return
	}
	syncDirectory(filepath.Dir(marker))
	delete(s.deletedGroups, groupID)
}

func (s *Server) retryGroupDeletions() {
	for id := range s.deletedGroups {
		s.finishGroupDeletion(id)
	}
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
	syncDirectory(directory)
	err = os.Remove(filepath.Join(s.config.DataDir, id+".deleted"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err == nil {
		syncDirectory(s.config.DataDir)
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
		if !marker.Type().IsRegular() || !strings.HasSuffix(marker.Name(), ".deleted") {
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
