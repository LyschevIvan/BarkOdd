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
		if s.groupMemberLocked(s.groups[room.GroupID], ownerID) {
			online := s.roomFreshLocked(room)
			rooms = append(rooms, summary{room.ID, room.Name, room.CreatedAt, online, online && room.Monitoring})
		}
	}
	sort.Slice(rooms, func(i, j int) bool { return rooms[i].CreatedAt.Before(rooms[j].CreatedAt) })
	writeJSON(w, 200, map[string]any{"rooms": rooms})
}

// Revoke only the affected account's streams and camera session. Guest
// capabilities survive while any owner of the shared room remains enabled.
// A group ID limits revocation to that group, otherwise it applies globally.
func (s *Server) invalidateAccessLocked(groupID, sessionKey, ownerID string) {
	for c := range s.streams {
		current := s.rooms[c.roomID]
		if current == nil || (groupID != "" && current.GroupID != groupID) {
			continue
		}
		affected := sessionKey != "" && c.authSession == sessionKey
		if ownerID != "" {
			pendingSession := s.auth.sessions[c.authSession]
			affected = affected || c.ownerID == ownerID ||
				(!c.authenticated && pendingSession != nil && pendingSession.UserID == ownerID) ||
				(c.ownerID == "" && !s.guestCameraAllowedLocked(current))
		}
		if affected {
			s.closeStreamLocked(c, streamClose{code: 1008, status: 401, message: "Сессия завершена или доступ отозван"})
		}
	}
	for _, current := range s.rooms {
		if groupID != "" && current.GroupID != groupID {
			continue
		}
		if (ownerID == "" || current.SourceOwnerID != ownerID) && (sessionKey == "" || current.SourceAuthSession != sessionKey) {
			continue
		}
		retireSession(current, current.SessionID)
		current.Monitoring = false
		current.LastSeenAt = nil
		current.SourceOwnerID = ""
		current.SourceAuthSession = ""
		current.rtcEpoch++
		s.refreshSourceLocked(current)
	}
}
