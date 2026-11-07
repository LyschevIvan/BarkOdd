package server

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const maxGroups = 1000

type group struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	MemberIDs []string  `json:"memberIds"`
}

type groupMember struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Disabled bool   `json:"disabled"`
}

type groupCamera struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Online     bool   `json:"online"`
	Monitoring bool   `json:"monitoring"`
}

type groupView struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	CreatedAt time.Time     `json:"createdAt"`
	Members   []groupMember `json:"members"`
	Cameras   []groupCamera `json:"cameras"`
}

func validRoomName(name string) bool {
	n := utf8.RuneCountInString(name)
	return utf8.ValidString(name) && n >= 1 && n <= 60
}

func readRoomName(w http.ResponseWriter, r *http.Request) (string, bool) {
	var body struct {
		Name string `json:"name"`
	}
	if !readJSON(w, r, 4096, &body) {
		return "", false
	}
	name := strings.TrimSpace(body.Name)
	if !validRoomName(name) {
		fail(w, 400, "Имя должно содержать от 1 до 60 символов")
		return "", false
	}
	return name, true
}

func (s *Server) groupPath(id, suffix string) string {
	return filepath.Join(s.config.DataDir, "groups", id+suffix)
}

func (s *Server) saveGroup(g *group) error {
	data, err := json.Marshal(g)
	if err != nil {
		return err
	}
	return atomicWrite(s.groupPath(g.ID, ".json"), data)
}

func (s *Server) initGroups() error {
	dir := filepath.Join(s.config.DataDir, "groups")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		id, marked := strings.CutSuffix(entry.Name(), ".deleted")
		if marked && entry.Type().IsRegular() && storageID.MatchString(id) {
			s.deletedGroups[id] = nil
		}
	}
	for _, entry := range entries {
		id, stored := strings.CutSuffix(entry.Name(), ".json")
		if !stored {
			continue
		}
		if _, deleted := s.deletedGroups[id]; deleted {
			return fmt.Errorf("room group %s has both active and deleted records", id)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !storageID.MatchString(id) || !info.Mode().IsRegular() || info.Size() > 64*1024 {
			return fmt.Errorf("invalid room group file %s", entry.Name())
		}
		data, err := os.ReadFile(s.groupPath(id, ".json"))
		if err != nil {
			return err
		}
		var g group
		if err := json.Unmarshal(data, &g); err != nil {
			return fmt.Errorf("invalid room group %s: %w", id, err)
		}
		if g.ID != id || !validRoomName(g.Name) || g.CreatedAt.IsZero() || len(g.MemberIDs) == 0 || len(g.MemberIDs) > maxAuthUsers+1 {
			return fmt.Errorf("invalid room group %s", id)
		}
		seen := make(map[string]bool, len(g.MemberIDs))
		for _, memberID := range g.MemberIDs {
			if s.groupUserLocked(memberID) == nil || seen[memberID] {
				return fmt.Errorf("invalid member in room group %s", id)
			}
			seen[memberID] = true
		}
		s.groups[id] = &g
	}
	return nil
}

// A legacy camera ID also identifies its group. Saving the group first
// allows a later startup to finish migration after a failed camera write.
func (s *Server) migrateLegacyCamera(current *room) error {
	updated := *current
	updated.GroupID = updated.ID
	if updated.OwnerID == "" {
		updated.OwnerID = authOwnerID
	}
	if s.groupUserLocked(updated.OwnerID) == nil {
		return errors.New("camera references unknown or incompatible owner")
	}
	g := s.groups[updated.GroupID]
	if g == nil {
		g = &group{ID: updated.GroupID, Name: updated.Name, CreatedAt: updated.CreatedAt, MemberIDs: []string{updated.OwnerID}}
		if err := s.saveGroup(g); err != nil {
			return fmt.Errorf("save group: %w", err)
		}
		s.groups[g.ID] = g
	} else if g.Name != updated.Name || !g.CreatedAt.Equal(updated.CreatedAt) || !slices.Equal(g.MemberIDs, []string{updated.OwnerID}) {
		return errors.New("existing group does not match legacy camera")
	}
	if err := s.save(&updated); err != nil {
		return fmt.Errorf("save camera: %w", err)
	}
	*current = updated
	return nil
}

func (s *Server) groupUserLocked(id string) *authUser {
	if id == authOwnerID {
		return &authOwner
	}
	return s.auth.users[id]
}

func (s *Server) groupMemberLocked(g *group, ownerID string) bool {
	return g != nil && slices.Contains(g.MemberIDs, ownerID) && s.ownerEnabledLocked(ownerID)
}

func (s *Server) guestCameraAllowedLocked(current *room) bool {
	g := s.groups[current.GroupID]
	return g != nil && slices.ContainsFunc(g.MemberIDs, s.ownerEnabledLocked)
}

func (s *Server) camerasInGroupLocked(groupID string) []*room {
	cameras := []*room{}
	for _, current := range s.rooms {
		if current.GroupID == groupID {
			cameras = append(cameras, current)
		}
	}
	return cameras
}

func (s *Server) groupViewLocked(g *group, cameras []*room) groupView {
	view := groupView{ID: g.ID, Name: g.Name, CreatedAt: g.CreatedAt, Members: make([]groupMember, 0, len(g.MemberIDs)), Cameras: make([]groupCamera, 0, len(cameras))}
	for _, memberID := range g.MemberIDs {
		member := s.groupUserLocked(memberID)
		view.Members = append(view.Members, groupMember{ID: member.ID, Username: member.Username, Disabled: member.Disabled})
	}
	slices.SortFunc(cameras, func(a, b *room) int {
		if order := a.CreatedAt.Compare(b.CreatedAt); order != 0 {
			return order
		}
		return cmp.Compare(a.ID, b.ID)
	})
	for _, current := range cameras {
		online := s.roomFreshLocked(current)
		view.Cameras = append(view.Cameras, groupCamera{ID: current.ID, Name: current.Name, Online: online, Monitoring: online && current.Monitoring})
	}
	return view
}

func (s *Server) handleGroupsLocked(w http.ResponseWriter, r *http.Request, parts []string) {
	user := s.principalLocked(r)
	if user == nil || len(r.Header.Values("Authorization")) != 0 {
		fail(w, 401, "Войдите, чтобы открыть свои комнаты")
		return
	}
	if len(parts) == 2 {
		switch r.Method {
		case http.MethodGet:
			s.listGroupsLocked(w, user.ID)
		case http.MethodPost:
			s.createGroupLocked(w, r, user.ID)
		default:
			fail(w, 405, "Метод не поддерживается")
		}
		return
	}
	g := s.groups[parts[2]]
	if g == nil {
		fail(w, 404, "Комната не найдена")
		return
	}
	if !s.groupMemberLocked(g, user.ID) {
		fail(w, 401, "Доступ к комнате отозван или отсутствует")
		return
	}
	switch {
	case len(parts) == 3 && r.Method == http.MethodGet:
		writeJSON(w, 200, s.groupViewLocked(g, s.camerasInGroupLocked(g.ID)))
	case len(parts) == 3 && r.Method == http.MethodDelete:
		s.deleteGroupLocked(w, g)
	case len(parts) == 4 && parts[3] == "cameras" && r.Method == http.MethodPost:
		s.createRoom(w, r, user.ID, g.ID)
	case len(parts) == 4 && parts[3] == "members" && r.Method == http.MethodPost:
		s.updateGroupMembersLocked(w, r, g, "")
	case len(parts) == 5 && parts[3] == "members" && parts[4] != "" && r.Method == http.MethodDelete:
		s.updateGroupMembersLocked(w, r, g, parts[4])
	default:
		fail(w, 404, "Адрес или метод не поддерживается")
	}
}

func (s *Server) listGroupsLocked(w http.ResponseWriter, ownerID string) {
	cameras := make(map[string][]*room)
	for _, current := range s.rooms {
		cameras[current.GroupID] = append(cameras[current.GroupID], current)
	}
	views := []groupView{}
	for _, g := range s.groups {
		if s.groupMemberLocked(g, ownerID) {
			views = append(views, s.groupViewLocked(g, cameras[g.ID]))
		}
	}
	slices.SortFunc(views, func(a, b groupView) int {
		if order := a.CreatedAt.Compare(b.CreatedAt); order != 0 {
			return order
		}
		return cmp.Compare(a.ID, b.ID)
	})
	writeJSON(w, 200, map[string]any{"groups": views})
}

func (s *Server) createGroupLocked(w http.ResponseWriter, r *http.Request, ownerID string) {
	name, ok := readRoomName(w, r)
	if !ok {
		return
	}
	if len(s.groups) >= maxGroups {
		fail(w, 429, "Достигнут лимит комнат сервера")
		return
	}
	id, err := randomID(12)
	if err != nil {
		fail(w, 500, "Не удалось создать ключ")
		return
	}
	g := &group{ID: id, Name: name, CreatedAt: s.now(), MemberIDs: []string{ownerID}}
	if err := s.saveGroup(g); err != nil {
		fail(w, 500, "Не удалось сохранить комнату")
		return
	}
	s.groups[g.ID] = g
	writeJSON(w, 201, s.groupViewLocked(g, nil))
}

func (s *Server) updateGroupMembersLocked(w http.ResponseWriter, r *http.Request, current *group, removeID string) {
	if s.config.AuthMode != "multi_user" {
		fail(w, 403, "Изменение хозяев доступно только с отдельными аккаунтами")
		return
	}
	updated := *current
	if removeID != "" {
		index := slices.Index(current.MemberIDs, removeID)
		if index < 0 {
			fail(w, 404, "Хозяин комнаты не найден")
			return
		}
		if len(current.MemberIDs) == 1 {
			fail(w, 409, "Нельзя удалить последнего хозяина комнаты")
			return
		}
		updated.MemberIDs = slices.Delete(slices.Clone(current.MemberIDs), index, index+1)
	} else {
		var body struct {
			Username string `json:"username"`
		}
		if !readJSON(w, r, 4096, &body) {
			return
		}
		target := s.groupUserByNameLocked(strings.ToLower(strings.TrimSpace(body.Username)))
		if target == nil {
			fail(w, 404, "Пользователь не найден")
			return
		}
		if slices.Contains(current.MemberIDs, target.ID) {
			writeJSON(w, 200, s.groupViewLocked(current, s.camerasInGroupLocked(current.ID)))
			return
		}
		updated.MemberIDs = append(slices.Clone(current.MemberIDs), target.ID)
	}
	if err := s.saveGroup(&updated); err != nil {
		fail(w, 500, "Не удалось сохранить хозяев комнаты")
		return
	}
	*current = updated
	if removeID != "" {
		s.invalidateAccessLocked(current.ID, "", removeID)
	}
	writeJSON(w, 200, s.groupViewLocked(current, s.camerasInGroupLocked(current.ID)))
}

func (s *Server) groupUserByNameLocked(username string) *authUser {
	if username == authOwner.Username {
		return &authOwner
	}
	for _, user := range s.auth.users {
		if username == user.Username {
			return user
		}
	}
	return nil
}
