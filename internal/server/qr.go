package server

import (
	qrcode "github.com/skip2/go-qrcode"
	"net/http"
	"net/url"
)

func (s *Server) qr(w http.ResponseWriter, r *http.Request, current *room) {
	var body struct {
		ViewerToken string `json:"viewerToken"`
		Origin      string `json:"origin"`
	}
	if !readJSON(w, r, 4096, &body) {
		return
	}
	if tokenHash(body.ViewerToken) != current.ViewerHash {
		fail(w, 400, "Ключ просмотра отозван. Создайте новую ссылку")
		return
	}
	origin := s.config.PublicURL
	if origin == "" {
		var err error
		origin, err = validOrigin(body.Origin)
		if err != nil {
			fail(w, 400, err.Error())
			return
		}
	}
	fragment := url.Values{"room": []string{current.ID}, "key": []string{body.ViewerToken}}
	data, err := qrcode.Encode(origin+"/?role=viewer#"+fragment.Encode(), qrcode.Medium, 320)
	if err != nil {
		fail(w, 500, "Не удалось создать QR-код")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}
