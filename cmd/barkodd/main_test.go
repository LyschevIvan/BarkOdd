package main

import (
	"reflect"
	"testing"
)

func TestOptionsRejectsIncompleteTLS(t *testing.T) {
	_, err := readOptions(func(k string) string {
		if k == "TLS_CERT_FILE" {
			return "cert.pem"
		}
		return ""
	})
	if err == nil {
		t.Fatal("a lone TLS certificate must not silently start plain HTTP")
	}
}

func TestOptionsSelectTransportAndICE(t *testing.T) {
	values := map[string]string{
		"MEDIA_TRANSPORT":   " webrtc ",
		"ROOM_CREATION_KEY": "test-owner-key-0123456789abcdef0123456789",
		"STUN_URLS":         " stun:one.example:3478, stun:two.example:3478 ",
		"TURN_URLS":         "turn:relay.example:3478?transport=udp, turns:relay.example:5349?transport=tcp",
		"TURN_SECRET":       "test-shared-secret",
	}
	o, err := readOptions(func(k string) string { return values[k] })
	if err != nil {
		t.Fatal(err)
	}
	if o.server.RoomCreationKey != values["ROOM_CREATION_KEY"] {
		t.Fatal("missing owner key")
	}
	if o.server.MediaTransport != "webrtc" {
		t.Fatalf("transport = %q", o.server.MediaTransport)
	}
	if !reflect.DeepEqual(o.server.STUNURLs, []string{"stun:one.example:3478", "stun:two.example:3478"}) {
		t.Fatalf("STUN list = %v", o.server.STUNURLs)
	}
	if !reflect.DeepEqual(o.server.TURNURLs, []string{"turn:relay.example:3478?transport=udp", "turns:relay.example:5349?transport=tcp"}) {
		t.Fatalf("TURN list = %v", o.server.TURNURLs)
	}
	if o.server.TURNSecret != "test-shared-secret" {
		t.Fatal("TURN shared secret was not passed to server config")
	}
}

func TestOptionsTransportDefaultsAndExplicitNoSTUN(t *testing.T) {
	o, err := readOptions(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if o.server.MediaTransport != "websocket" || o.server.STUNURLs != nil {
		t.Fatal("default must be WebSocket with default ICE selection")
	}
	values := map[string]string{"MEDIA_TRANSPORT": "webrtc", "STUN_URLS": "none", "TURN_USERNAME": "user", "TURN_PASSWORD": "password"}
	o, err = readOptions(func(k string) string { return values[k] })
	if err != nil {
		t.Fatal(err)
	}
	if o.server.STUNURLs == nil || len(o.server.STUNURLs) != 0 {
		t.Fatal("none must explicitly disable default STUN")
	}
	if o.server.TURNUsername != "user" || o.server.TURNPassword != "password" {
		t.Fatal("static TURN credentials were not passed")
	}
}

func TestOptionsDefaultLocalAndPublicPath(t *testing.T) {
	values := map[string]string{"PUBLIC_URL": "https://example.test/barkodd/", "DATA_DIR": "/tmp/barkodd-options-test"}
	o, err := readOptions(func(k string) string { return values[k] })
	if err != nil {
		t.Fatal(err)
	}
	if o.addr != "127.0.0.1:8080" {
		t.Fatalf("unexpected default binding: %s", o.addr)
	}
	if o.server.PublicURL != "https://example.test/barkodd/" || o.server.DataDir != "/tmp/barkodd-options-test" {
		t.Fatalf("public path or data directory lost: %+v", o.server)
	}
}

func TestOptionsPassesAuthModesAndAdminCode(t *testing.T) {
	for _, mode := range []string{"none", "admin_code", "multi_user"} {
		values := map[string]string{"AUTH_MODE": " " + mode + " ", "ADMIN_CODE": "owner-code-0123456789abcdef0123456789"}
		o, err := readOptions(func(k string) string { return values[k] })
		if err != nil || o.server.AuthMode != mode || o.server.AdminCode != values["ADMIN_CODE"] {
			t.Fatalf("auth options: %#v %v", o.server, err)
		}
	}
	o, err := readOptions(func(string) string { return "" })
	if err != nil || o.server.AuthMode != "admin_code" {
		t.Fatal("unsafe auth default", o, err)
	}
}
