package server

import (
	"net/http"
	"regexp"
	"sort"
	"time"
)

var ownerKeyFormat = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)

func (s *Server) approveRoom(w http.ResponseWriter, r *http.Request, current *room) {
	updated := *current
	updated.OwnerApproved = true
	if err := s.save(&updated); err != nil {
		fail(w, 500, "Не удалось подтвердить комнату")
		return
	}
	*current = updated
	// Reconnect control sockets to obtain newly permitted ICE credentials.
	for c := range s.streams {
		if c.roomID == current.ID {
			s.closeStreamLocked(c, streamClose{code: 1012})
		}
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) listRooms(w http.ResponseWriter, ownerID string) {
	type summary struct {
		ID         string    `json:"id"`
		Name       string    `json:"name"`
		CreatedAt  time.Time `json:"createdAt"`
		Online     bool      `json:"online"`
		Monitoring bool      `json:"monitoring"`
	}
	rooms := []summary{}
	for _, room := range s.rooms {
		if room.OwnerID == ownerID {
			online := s.roomFreshLocked(room)
			rooms = append(rooms, summary{room.ID, room.Name, room.CreatedAt, online, online && room.Monitoring})
		}
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].CreatedAt.Before(rooms[j].CreatedAt) })
	writeJSON(w, 200, map[string]any{"rooms": rooms})
}

// Called with s.mu held, after a session is removed or an owner is disabled.
func (s *Server) invalidateAuthLocked(sessionKey, ownerID string) {
	if sessionKey == "" && ownerID == "" {
		return
	}
	for c := range s.streams {
		room := s.rooms[c.roomID]
		if (sessionKey != "" && c.authSession == sessionKey) || (ownerID != "" && room != nil && room.OwnerID == ownerID) {
			s.closeStreamLocked(c, streamClose{code: 1008, status: 401, message: "Сессия завершена или доступ отозван"})
		}
	}
	for _, room := range s.rooms {
		matches := ownerID != "" && room.OwnerID == ownerID
		if matches || (sessionKey != "" && room.SourceAuthSession == sessionKey) {
			if room.SessionID != "" {
				retireSession(room, room.SessionID)
			}
			room.Monitoring = false
			room.LastSeenAt = nil
			room.SourceAuthSession = ""
			room.rtcEpoch++
			s.refreshSourceLocked(room)
		}
	}

}
