package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLANActuallyNegotiatesHTTP2(t *testing.T) {
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := make(chan event, 1)
	done := make(chan error, 1)
	go func() {
		done <- runLAN(ctx, t.TempDir(), port, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, r.Proto) }), func(e event) { ready <- e })
	}()
	var info event
	select {
	case info = <-ready:
	case err = <-done:
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("listener did not start")
	}
	transport := &http.Transport{ForceAttemptHTTP2: true, TLSClientConfig: &tls.Config{InsecureSkipVerify: true, VerifyConnection: func(state tls.ConnectionState) error {
		digest := sha256.Sum256(state.PeerCertificates[0].Raw)
		if hex.EncodeToString(digest[:]) != info.Fingerprint {
			return fmt.Errorf("fingerprint mismatch")
		}
		return nil
	}}}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport, Timeout: 5 * time.Second}).Get(fmt.Sprintf("https://127.0.0.1:%d/", port))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.ProtoMajor != 2 {
		t.Fatalf("got %s, expected HTTP/2", response.Proto)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("listener did not stop")
	}
}

func TestLANIdentitySurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	first, err := lanCertificate(dir)
	if err != nil {
		t.Fatal(err)
	}
	second, err := lanCertificate(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(first.Certificate[0], second.Certificate[0]) {
		t.Fatal("certificate changed after restart")
	}
	info, err := os.Stat(filepath.Join(dir, "lan-identity.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0077 != 0 {
		t.Fatal("private key is readable by other users")
	}
	if err := os.WriteFile(filepath.Join(dir, "lan-identity.pem"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := lanCertificate(dir); err == nil {
		t.Fatal("corrupt identity must not be silently replaced")
	}
}
