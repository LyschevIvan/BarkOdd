package server

import (
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func photoEventResponse(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var result map[string]any
	decode(t, response, &result)
	return result
}

func TestEventOfflinePhotosSaveBackToBackRegardlessOfInterval(t *testing.T) {
	for _, interval := range []int{10000, 300000} {
		t.Run(fmt.Sprint(interval), func(t *testing.T) {
			f := setup(t)
			f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": 0.1, "snapshotIntervalMs": interval}, 200)
			startEventSession(f)
			for i := 0; i < 3; i++ {
				body := eventBody(fmt.Sprintf("queued-%d", i), photo(uint8(30+i)))
				body["detectedAt"], body["photoAt"] = f.now.Add(time.Duration(i-3)*time.Minute), f.now.Add(time.Duration(i-3)*time.Minute)
				result := photoEventResponse(t, f.call("POST", f.path("/events"), f.host, body, 200))
				if result["photoStatus"] != "accepted" || result["hasPhoto"] != true || result["photoAt"] != body["photoAt"].(time.Time).Format(time.RFC3339Nano) {
					t.Fatal("valid queued photo was not saved immediately", result)
				}
				f.call("GET", f.path("/events/"+result["id"].(string)+"/photo"), f.viewer, nil, 200)
			}
			f.call("POST", f.path("/events"), f.host, eventBody("request-limited", photo(60)), 429)
			f.now = f.now.Add(500 * time.Millisecond)
			result := photoEventResponse(t, f.call("POST", f.path("/events"), f.host, eventBody("request-limited", photo(60)), 200))
			if result["photoStatus"] != "accepted" {
				t.Fatal("photo remained blocked after request rate budget refilled", result)
			}
			restartHistoryServer(t, f)
			files, err := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
			if err != nil || len(files) != 4 || f.state()["eventCount"] != float64(4) {
				t.Fatal("queued photo history did not survive restart", files, err)
			}
		})
	}
}

func TestEventPhotoDispositionAcknowledgesSameAndOlderCapture(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	body := eventBody("episode", photo(30))
	body["photoAt"] = f.now.Add(-2 * time.Minute)
	first := photoEventResponse(t, f.call("POST", f.path("/events"), f.host, body, 200))
	body["photoAt"] = f.now.Add(-time.Minute)
	body["photo"] = photo(60)
	newer := photoEventResponse(t, f.call("POST", f.path("/events"), f.host, body, 200))
	if newer["photoStatus"] != "accepted" || newer["photoAt"] == first["photoAt"] || newer["id"] != first["id"] {
		t.Fatal("newer capture did not replace the episode photo immediately", first, newer)
	}
	for _, captured := range []any{body["photoAt"], f.now.Add(-2 * time.Minute)} {
		body["photoAt"] = captured
		f.now = f.now.Add(500 * time.Millisecond)
		duplicate := photoEventResponse(t, f.call("POST", f.path("/events"), f.host, body, 200))
		if duplicate["photoStatus"] != "duplicate" || duplicate["photoAt"] != newer["photoAt"] || duplicate["lastNoiseAt"] != f.now.Format(time.RFC3339Nano) {
			t.Fatal("duplicate or older photo replaced a newer photo or suppressed noise", duplicate)
		}
	}
	f.now = f.now.Add(500 * time.Millisecond)
	noise := photoEventResponse(t, f.call("POST", f.path("/events"), f.host, eventBody("episode", ""), 200))
	if noise["photoStatus"] != "none" || noise["photoAt"] != newer["photoAt"] {
		t.Fatal("noise-only update changed the saved photo", noise)
	}
	files, err := filepath.Glob(filepath.Join(f.dir, "photos", "*.jpg"))
	if err != nil || len(files) != 1 {
		t.Fatal("replacing a photo leaked the previous file", files, err)
	}
}

func TestEventIntervalChangeDuringDecodeDoesNotRejectPhoto(t *testing.T) {
	f := setup(t)
	startEventSession(f)
	f.call("POST", f.path("/events"), f.host, eventBody("old", photo(30)), 200)
	request, body, reservation := reserveEventForTest(t, f, f.path(""), f.host)
	if !reservation.decodePhoto {
		t.Fatal("recent upload prevented decoding another valid photo")
	}
	f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": 0.1, "snapshotIntervalMs": 300000}, 200)
	response := httptest.NewRecorder()
	f.s.commitEvent(response, request, reservation, body, jpegFrame(60))
	result := photoEventResponse(t, response)
	if response.Code != 200 || result["photoStatus"] != "accepted" || result["hasPhoto"] != true {
		t.Fatal("settings changed admission of an in-flight photo", response.Code, result)
	}
}

func TestRoomResponsesDoNotAdvertiseServerPhotoSchedule(t *testing.T) {
	f := setup(t)
	responses := []*httptest.ResponseRecorder{
		f.call("POST", f.path("/heartbeat"), f.host, map[string]any{"sessionId": "event-camera", "monitoring": true}, 200),
		f.call("POST", f.path("/events"), f.host, eventBody("episode", photo(30)), 200),
		f.call("GET", f.path(""), f.viewer, nil, 200),
		f.call("PUT", f.path("/settings"), f.host, map[string]any{"threshold": 0.1, "snapshotIntervalMs": 60000}, 200),
		f.call("DELETE", f.path("/events"), f.host, nil, 200),
	}
	stale := eventBody("old", photo(30))
	stale["historyVersion"] = 1
	responses = append(responses, f.call("POST", f.path("/events"), f.host, stale, 200))
	for _, response := range responses {
		if result := photoEventResponse(t, response); result["photoPolicy"] != nil {
			t.Errorf("response still advertises a server photo schedule: %v", result)
		}
	}
	result := photoEventResponse(t, responses[len(responses)-1])
	if result["photoStatus"] != "discarded" || result["discarded"] != true || result["historyVersion"] != float64(2) {
		t.Fatal("stale history lost explicit disposition", result)
	}
}
