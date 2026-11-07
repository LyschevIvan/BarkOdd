package server

import (
	"bytes"
	"encoding/base64"
	"errors"
	"image/jpeg"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
)

const (
	eventRatePerSecond   = 2
	eventBurst           = 3
	maxEventPhotoDecodes = 4
	photoDataPrefix      = "data:image/jpeg;base64,"
)

type eventPayload struct {
	SessionID      string     `json:"sessionId"`
	EpisodeID      string     `json:"episodeId"`
	Level          *float64   `json:"level"`
	Photo          string     `json:"photo"`
	DetectedAt     *time.Time `json:"detectedAt"`
	PhotoAt        *time.Time `json:"photoAt"`
	HistoryVersion *uint64    `json:"historyVersion"`
	detectedAt     time.Time
	photoAt        time.Time
}

// A reservation bounds work while the shared room mutex remains available to
// heartbeats and live video. Its original room also identifies deletion races.
type eventReservation struct {
	server         *Server
	current        *room
	decodePhoto    bool
	released       bool
	historyVersion uint64
}

func (s *Server) serveEvent(w http.ResponseWriter, r *http.Request, roomID string) {
	// Keep authentication ahead of JSON errors, including viewer-only requests.
	s.mu.Lock()
	current := s.eventRoomLocked(w, r, roomID)
	s.mu.Unlock()
	if current == nil {
		return
	}
	body := s.parseEvent(w, r)
	if body == nil {
		return
	}
	reservation := s.reserveEvent(w, r, roomID, body)
	if reservation == nil {
		return
	}
	defer reservation.release()
	var picture []byte
	if reservation.decodePhoto {
		var err error
		picture, err = base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(body.Photo, photoDataPrefix))
		if err != nil || len(picture) == 0 {
			fail(w, 400, "Некорректная фотография")
			return
		}
		if len(picture) > maxPhotoBytes {
			fail(w, 413, "Фотография превышает 400 КиБ")
			return
		}
		if err := validateEventJPEG(bytes.NewReader(picture)); err != nil {
			fail(w, 400, err.Error())
			return
		}
	}
	s.commitEvent(w, r, reservation, body, picture)
}

func (s *Server) eventRoomLocked(w http.ResponseWriter, r *http.Request, roomID string) *room {
	if s.closed {
		fail(w, 503, "Сервер завершает работу")
		return nil
	}
	current := s.rooms[roomID]
	if !storageID.MatchString(roomID) || current == nil {
		fail(w, 404, "Комната не найдена")
		return nil
	}
	role := s.authorizeLocked(r, current)
	if role == "" {
		fail(w, 401, "Неверный или отозванный ключ комнаты")
		return nil
	}
	if role != "host" {
		fail(w, 403, "Действие доступно только устройству питомца")
		return nil
	}
	return current
}

func (s *Server) parseEvent(w http.ResponseWriter, r *http.Request) *eventPayload {
	var body eventPayload
	if !readJSON(w, r, 560*1024, &body) {
		return nil
	}
	if !identifier.MatchString(body.EpisodeID) || strings.Contains(body.EpisodeID, "..") || body.Level == nil || *body.Level < 0 || *body.Level > 1 {
		fail(w, 400, "Некорректный идентификатор эпизода или уровень шума")
		return nil
	}
	now := s.now()
	body.detectedAt, body.photoAt = now, now
	if body.DetectedAt != nil {
		body.detectedAt = body.DetectedAt.UTC()
	}
	if body.PhotoAt != nil {
		body.photoAt = body.PhotoAt.UTC()
	}
	validTime := func(value time.Time) bool {
		return !value.Before(now.Add(-24*time.Hour)) && !value.After(now.Add(5*time.Second))
	}
	if !validTime(body.detectedAt) || (body.PhotoAt != nil && (body.Photo == "" || !validTime(body.photoAt))) {
		fail(w, 400, "Время события или фотографии выходит за допустимый диапазон")
		return nil
	}
	if body.Photo != "" {
		if !strings.HasPrefix(body.Photo, photoDataPrefix) {
			fail(w, 400, "Ожидается JPEG-фотография")
			return nil
		}
		encoded := strings.TrimPrefix(body.Photo, photoDataPrefix)
		if len(encoded) > base64.StdEncoding.EncodedLen(maxPhotoBytes) {
			fail(w, 413, "Фотография превышает 400 КиБ")
			return nil
		}
	}
	return &body
}

func (s *Server) reserveEvent(w http.ResponseWriter, r *http.Request, roomID string, body *eventPayload) *eventReservation {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.eventRoomLocked(w, r, roomID)
	if current == nil {
		return nil
	}
	if !validEventSession(current, body.SessionID) {
		fail(w, 403, "Сессия камеры завершена или заменена")
		return nil
	}
	if clearedNoise(current, body) {
		discardEvent(w, current)
		return nil
	}
	now := s.now()
	decodePhoto := body.Photo != "" && !clearedPhoto(current, body) && eventPhotoDue(current, body, now)
	if current.eventBusy || (decodePhoto && s.eventPhotoDecodes >= maxEventPhotoDecodes) {
		fail(w, 429, "Обработка событий занята; повторите запрос позже")
		return nil
	}
	if current.eventCreditAt.IsZero() {
		current.eventCredit = eventBurst
		current.eventCreditAt = now
	} else if now.After(current.eventCreditAt) {
		current.eventCredit = min(eventBurst, current.eventCredit+now.Sub(current.eventCreditAt).Seconds()*eventRatePerSecond)
		current.eventCreditAt = now
	}
	if current.eventCredit < 1 {
		fail(w, 429, "Слишком частые события; повторите запрос позже")
		return nil
	}
	current.eventCredit--
	current.eventBusy = true
	if decodePhoto {
		s.eventPhotoDecodes++
	}
	return &eventReservation{server: s, current: current, decodePhoto: decodePhoto, historyVersion: current.HistoryVersion}
}

func eventPhotoDue(current *room, body *eventPayload, now time.Time) bool {
	if current.LastPhotoAt != nil && now.Sub(*current.LastPhotoAt) < time.Duration(current.Settings.SnapshotIntervalMS)*time.Millisecond {
		return false
	}
	for _, event := range current.Events {
		if event.EpisodeID == body.EpisodeID && now.Sub(event.LastNoiseAt) <= retention && event.PhotoAt != nil && !body.photoAt.After(*event.PhotoAt) {
			return false
		}
	}
	return true
}

func (reservation *eventReservation) release() {
	s := reservation.server
	s.mu.Lock()
	defer s.mu.Unlock()
	if reservation.released {
		return
	}
	reservation.released = true
	reservation.current.eventBusy = false
	if reservation.decodePhoto {
		s.eventPhotoDecodes--
	}
}

func validateEventJPEG(reader io.ReadSeeker) error {
	cfg, err := jpeg.DecodeConfig(reader)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > 4096 || cfg.Height > 4096 || cfg.Width*cfg.Height > 12000000 {
		return errors.New("Некорректная или слишком большая JPEG-фотография")
	}
	if _, err := reader.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if _, err := jpeg.Decode(reader); err != nil {
		return errors.New("Повреждённая JPEG-фотография")
	}
	return nil
}

func (s *Server) commitEvent(w http.ResponseWriter, r *http.Request, reservation *eventReservation, body *eventPayload, picture []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.eventRoomLocked(w, r, reservation.current.ID)
	if current == nil {
		return
	}
	if current != reservation.current || !validEventSession(current, body.SessionID) || (s.config.AuthMode != "none" && current.SourceAuthSession != s.sessionKey(r)) {
		fail(w, 403, "Сессия камеры завершена или заменена")
		return
	}
	if current.HistoryVersion != reservation.historyVersion || clearedNoise(current, body) {
		discardEvent(w, current)
		return
	}
	photoDiscarded := clearedPhoto(current, body)
	now := s.now()
	detectedAt, photoAt := body.detectedAt, body.photoAt
	updated, removed, _ := compact(current, now)
	index := -1
	for i, e := range updated.Events {
		if e.EpisodeID == body.EpisodeID {
			index = i
			break
		}
	}
	if index < 0 {
		id, err := randomID(12)
		if err != nil {
			fail(w, 500, "Не удалось создать событие")
			return
		}
		updated.Events = append(updated.Events, storedEvent{Event: Event{ID: id, StartedAt: detectedAt}, EpisodeID: body.EpisodeID})
		index = len(updated.Events) - 1
	}
	event := &updated.Events[index]
	if detectedAt.Before(event.StartedAt) {
		event.StartedAt = detectedAt
	}
	if !detectedAt.Before(event.LastNoiseAt) {
		event.LastNoiseAt = detectedAt
		event.Level = *body.Level
	}
	if updated.LastNoiseAt == nil || detectedAt.After(*updated.LastNoiseAt) {
		updated.LastNoiseAt = &detectedAt
	}
	newPhoto := ""
	if len(picture) > 0 && !photoDiscarded && (event.PhotoAt == nil || photoAt.After(*event.PhotoAt)) && (updated.LastPhotoAt == nil || now.Sub(*updated.LastPhotoAt) >= time.Duration(updated.Settings.SnapshotIntervalMS)*time.Millisecond) {
		id, err := randomID(12)
		if err != nil {
			fail(w, 500, "Не удалось сохранить фотографию")
			return
		}
		newPhoto = updated.ID + "_" + event.ID + "_" + id + ".jpg"
		if err = atomicWrite(s.photoPath(newPhoto), picture); err != nil {
			fail(w, 500, "Не удалось сохранить фотографию")
			return
		}
		if event.PhotoFile != "" {
			removed = append(removed, event.PhotoFile)
		}
		event.PhotoFile = newPhoto
		event.PhotoAt = &photoAt
		event.HasPhoto = true
		updated.LastPhotoAt = &now
	}
	result := event.Event
	updated, extraRemoved, _ := compact(&updated, now)
	removed = append(removed, extraRemoved...)
	if err := s.save(&updated); err != nil {
		if newPhoto != "" {
			s.removePhotos([]string{newPhoto})
		}
		fail(w, 500, "Не удалось сохранить событие")
		return
	}
	*current = updated
	s.removePhotos(removed)
	writeJSON(w, 200, struct {
		Event
		PhotoDiscarded bool   `json:"photoDiscarded,omitempty"`
		HistoryVersion uint64 `json:"historyVersion"`
	}{result, photoDiscarded, current.HistoryVersion})
}

func (s *Server) getPhoto(w http.ResponseWriter, r *http.Request, current *room, eventID string) {
	if !storageID.MatchString(eventID) {
		fail(w, 404, "Фотография не найдена")
		return
	}
	if !s.prune(w, current) {
		return
	}
	for _, event := range current.Events {
		if event.ID != eventID || !event.HasPhoto {
			continue
		}
		data, err := os.ReadFile(s.photoPath(event.PhotoFile))
		if err != nil {
			fail(w, 404, "Фотография недоступна")
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(200)
		_, _ = w.Write(data)
		return
	}
	fail(w, 404, "Фотография не найдена")
}

func validEventSession(current *room, sessionID string) bool {
	return identifier.MatchString(sessionID) && current.SessionID == sessionID && !slices.Contains(current.RetiredSessions, sessionID)
}
