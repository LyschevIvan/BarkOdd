package server

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
	"unicode/utf8"
)

var photoName = regexp.MustCompile(`^[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{16}\.jpg$`)

func validateStored(r *room) error {
	if !storageID.MatchString(r.ID) || !utf8.ValidString(r.Name) || utf8.RuneCountInString(r.Name) < 1 || utf8.RuneCountInString(r.Name) > 60 || r.CreatedAt.IsZero() {
		return errors.New("invalid room identity")
	}
	for _, hash := range []string{r.HostHash, r.ViewerHash} {
		b, err := hex.DecodeString(hash)
		if err != nil || len(b) != 32 {
			return errors.New("invalid credential hash")
		}
	}
	if r.HostHash == r.ViewerHash {
		return errors.New("role credentials must differ")
	}
	if r.Settings.Threshold < 0.005 || r.Settings.Threshold > 0.5 || r.Settings.QuietMS != 5000 || r.Settings.SnapshotIntervalMS < 10000 || r.Settings.SnapshotIntervalMS > 300000 {
		return errors.New("invalid settings")
	}
	if len(r.Events) > maxEvents {
		return errors.New("too many persisted events")
	}
	ids := map[string]bool{}
	episodes := map[string]bool{}
	for _, e := range r.Events {
		if !storageID.MatchString(e.ID) || !identifier.MatchString(e.EpisodeID) || ids[e.ID] || episodes[e.EpisodeID] || e.StartedAt.IsZero() || e.LastNoiseAt.Before(e.StartedAt) || e.Level < 0 || e.Level > 1 {
			return errors.New("invalid event")
		}
		ids[e.ID] = true
		episodes[e.EpisodeID] = true
		if e.HasPhoto != (e.PhotoFile != "") || e.HasPhoto != (e.PhotoAt != nil) {
			return errors.New("inconsistent photo metadata")
		}
		if e.HasPhoto && (!photoName.MatchString(e.PhotoFile) || len(e.PhotoFile) < 34 || e.PhotoFile[:16] != r.ID || e.PhotoFile[17:33] != e.ID) {
			return errors.New("invalid photo path")
		}
	}
	return nil
}

// A successful return means the complete replacement reached the filesystem;
// failed writes never truncate or replace the last good version.
func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".barkodd-*")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(temp, path); err != nil {
		return err
	}
	// Directory sync is best effort: some supported filesystems do not expose it.
	if d, openErr := os.Open(filepath.Dir(path)); openErr == nil {
		_ = d.Sync()
		_ = d.Close()
	}
	return nil
}
func (s *Server) save(r *room) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.config.DataDir, r.ID+".json"), data)
}
func (s *Server) photoPath(file string) string {
	return filepath.Join(s.config.DataDir, "photos", file)
}

// compact returns a copy so failed disk writes leave the live room unchanged.
func compact(current *room, now time.Time) (room, []string, bool) {
	updated := *current
	updated.Events = make([]storedEvent, 0, len(current.Events))
	removed := []string{}
	changed := false
	for _, e := range current.Events {
		if now.Sub(e.LastNoiseAt) > retention {
			if e.PhotoFile != "" {
				removed = append(removed, e.PhotoFile)
			}
			changed = true
			continue
		}
		if e.PhotoAt != nil && now.Sub(*e.PhotoAt) > retention {
			removed = append(removed, e.PhotoFile)
			e.PhotoFile = ""
			e.PhotoAt = nil
			e.HasPhoto = false
			changed = true
		}
		updated.Events = append(updated.Events, e)
	}
	sort.SliceStable(updated.Events, func(i, j int) bool { return updated.Events[i].LastNoiseAt.After(updated.Events[j].LastNoiseAt) })
	if len(updated.Events) > maxEvents {
		for _, e := range updated.Events[maxEvents:] {
			if e.PhotoFile != "" {
				removed = append(removed, e.PhotoFile)
			}
		}
		updated.Events = updated.Events[:maxEvents]
		changed = true
	}
	return updated, removed, changed
}
func (s *Server) removePhotos(files []string) {
	for _, file := range files {
		_ = os.Remove(s.photoPath(file))
	}
}
func (s *Server) prune(w http.ResponseWriter, current *room) bool {
	updated, removed, changed := compact(current, s.now())
	if !changed {
		return true
	}
	if err := s.save(&updated); err != nil {
		fail(w, 500, "Не удалось обновить историю")
		return false
	}
	*current = updated
	s.removePhotos(removed)
	return true
}

// verifyPhotos catches damaged storage instead of silently displaying broken history.
func (s *Server) verifyPhotos() error {
	for _, r := range s.rooms {
		for _, e := range r.Events {
			if e.HasPhoto {
				info, err := os.Stat(s.photoPath(e.PhotoFile))
				if err != nil {
					return fmt.Errorf("room %s photo %s: %w", r.ID, e.ID, err)
				}
				if info.Size() == 0 || info.Size() > maxPhotoBytes {
					return fmt.Errorf("invalid photo size in room %s", r.ID)
				}
			}
		}
	}
	return nil
}

func (s *Server) sweep() error {
	s.retryRoomDeletions()
	now := s.now()
	for _, current := range s.rooms {
		updated, removed, changed := compact(current, now)
		if !changed {
			continue
		}
		if err := s.save(&updated); err != nil {
			return fmt.Errorf("prune room %s: %w", current.ID, err)
		}
		*current = updated
		s.removePhotos(removed)
	}
	return nil
}

func (s *Server) cleanupLoop() {
	defer close(s.stopped)
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.mu.Lock()
			if !s.closed {
				if err := s.sweep(); err != nil {
					log.Printf("BarkOdd history cleanup: %v", err)
				}
			}
			s.mu.Unlock()
		}
	}
}
