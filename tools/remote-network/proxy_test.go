package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestBackendProxyReportsActualPeerAfterUntrustedForwardedHeader(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.Header.Get("X-Forwarded-For"))
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	proxy := newBackendProxy(target)
	defer proxy.Transport.(*http.Transport).CloseIdleConnections()
	request := httptest.NewRequest(http.MethodGet, "http://192.168.1.8:7691/v1/status", nil)
	request.RemoteAddr = net.JoinHostPort("100.64.0.7", "12345")
	request.Header.Set("X-Forwarded-For", "8.8.8.8")
	response := httptest.NewRecorder()
	proxy.ServeHTTP(response, request)
	parts := strings.Split(response.Body.String(), ",")
	if response.Code != http.StatusOK || strings.TrimSpace(parts[len(parts)-1]) != "100.64.0.7" {
		t.Fatalf("actual peer missing from proxy chain: %s", response.Body.String())
	}
}

func TestBackendProxyCancelsSlowRequestWhenClientLeaves(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	proxy := newBackendProxy(target)
	defer proxy.Transport.(*http.Transport).CloseIdleConnections()
	server := httptest.NewServer(proxy)
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		response, err := server.Client().Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		done <- err
	}()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("request did not reach backend")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(3 * time.Second):
		t.Fatal("backend request survived client cancellation")
	}
	if err := <-done; err == nil {
		t.Fatal("cancelled request succeeded")
	}
}

func TestBackendProxyAllowsSlowBusinessResponse(t *testing.T) {
	started := make(chan struct{})
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			close(started)
			select {
			case <-time.After(11 * time.Second):
			case <-r.Context().Done():
				return
			}
		}
		_, _ = io.WriteString(w, "ready")
	}))
	defer backend.Close()
	target, _ := url.Parse(backend.URL)
	proxy := newBackendProxy(target)
	defer proxy.Transport.(*http.Transport).CloseIdleConnections()
	server := httptest.NewServer(proxy)
	defer server.Close()
	client := &http.Client{Timeout: 15 * time.Second}
	type result struct {
		status int
		body   string
		err    error
	}
	read := func(path string) result {
		response, err := client.Get(server.URL + path)
		if err != nil {
			return result{err: err}
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		return result{response.StatusCode, string(body), err}
	}
	done := make(chan result, 1)
	go func() { done <- read("/slow") }()
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("slow request did not start")
	}
	fast := make(chan result, 1)
	go func() { fast <- read("/tasks") }()
	select {
	case value := <-fast:
		if value.err != nil || value.status != http.StatusOK || value.body != "ready" {
			t.Fatalf("fast response: %+v", value)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("task read waited for slow business request")
	}
	value := <-done
	if value.err != nil || value.status != http.StatusOK || value.body != "ready" {
		t.Fatalf("slow response: %+v", value)
	}
}
