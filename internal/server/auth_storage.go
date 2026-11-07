package server

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Auth disk records expose password material only to the private store.
type authDiskStore struct {
	Version int            `json:"version"`
	Mode    string         `json:"mode"`
	Users   []authDiskUser `json:"users"`
}
type authDiskUser struct {
	authUser
	PasswordHash string `json:"passwordHash"`
	Salt         string `json:"salt"`
}

func (s *Server) initAuth() error {
	s.auth = authState{users: make(map[string]*authUser), sessions: make(map[string]*authSession), attempts: make(map[string]authAttempt), hashSlots: make(chan struct{}, 2)}
	dir := filepath.Join(s.config.DataDir, "auth")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("auth storage: %w", err)
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return err
	}
	path := filepath.Join(dir, "users.json")
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return s.saveAuthUsersLocked(s.auth.users)
	}
	if err != nil {
		return fmt.Errorf("auth storage: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	if info.Size() > 2*1024*1024 {
		return errors.New("auth storage too large")
	}
	dec := json.NewDecoder(io.LimitReader(f, 2*1024*1024+1))
	dec.DisallowUnknownFields()
	var store authDiskStore
	if err = dec.Decode(&store); err != nil {
		return fmt.Errorf("invalid auth storage: %w", err)
	}
	if err = dec.Decode(new(any)); err != io.EOF {
		return errors.New("invalid trailing auth storage data")
	}
	if store.Version != 1 || (store.Mode != "none" && store.Mode != "admin_code" && store.Mode != "multi_user") || store.Users == nil || len(store.Users) > maxAuthUsers {
		return errors.New("invalid auth storage schema")
	}
	names := map[string]bool{}
	for _, stored := range store.Users {
		u := stored.authUser
		u.PasswordHash = stored.PasswordHash
		u.Salt = stored.Salt
		hash, herr := hex.DecodeString(u.PasswordHash)
		salt, serr := hex.DecodeString(u.Salt)
		if !storageID.MatchString(u.ID) || u.ID == authOwnerID || !validAuthUsername(u.Username) || u.Username != strings.ToLower(u.Username) || u.Role != "user" || u.CreatedAt.IsZero() || herr != nil || serr != nil || len(hash) != 32 || len(salt) != 16 || s.auth.users[u.ID] != nil || names[u.Username] {
			return errors.New("invalid auth user record")
		}
		names[u.Username] = true
		s.auth.users[u.ID] = &u
	}
	if s.config.AuthMode != "multi_user" && len(s.auth.users) > 0 {
		return errors.New("cannot switch to single-user auth mode while regular accounts exist; use a separate DATA_DIR")
	}
	return nil
}
func (s *Server) saveAuthUsersLocked(users map[string]*authUser) error {
	store := authDiskStore{Version: 1, Mode: s.config.AuthMode, Users: make([]authDiskUser, 0, len(users))}
	for _, u := range sortedAuthUsers(users) {
		store.Users = append(store.Users, authDiskUser{authUser: *u, PasswordHash: u.PasswordHash, Salt: u.Salt})
	}
	data, err := json.Marshal(store)
	if err != nil {
		return err
	}
	return atomicWrite(filepath.Join(s.config.DataDir, "auth", "users.json"), data)
}
func cloneAuthUsers(users map[string]*authUser) map[string]*authUser {
	out := make(map[string]*authUser, len(users))
	for id, u := range users {
		out[id] = u
	}
	return out
}
