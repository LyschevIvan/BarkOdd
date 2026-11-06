package server

import (
	"crypto/subtle"
	"net/http"
	"regexp"
	"strings"
)

var ownerKeyFormat = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)

func (s *Server) ownerAuthorized(key string) bool {
	if s.config.RoomCreationKey == "" || !ownerKeyFormat.MatchString(key) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(tokenHash(key)), []byte(tokenHash(s.config.RoomCreationKey))) == 1
}

func (s *Server) approveRoom(w http.ResponseWriter, r *http.Request, current *room) {
	if !s.ownerAuthorized(r.Header.Get("X-BarkOdd-Owner-Key")) {
		fail(w, http.StatusForbidden, "Укажите верный ключ владельца сервера")
		return
	}
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

func (s *Server) creationAuthorized(r *http.Request) bool {
	value, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	return ok && s.ownerAuthorized(value)
}
