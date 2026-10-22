package androidnet

import (
	"os"
	"path/filepath"
	"tailscale.com/logpolicy"
	"tailscale.com/types/logger"
	"testing"
)

func TestSandboxLogDirectory(t *testing.T) {
	state := filepath.Join(t.TempDir(), "private-state")
	t.Setenv("HOME", "")
	t.Setenv("XDG_CACHE_HOME", "")
	t.Setenv("TS_LOGS_DIR", "")
	if err := prepareStateDir(state); err != nil {
		t.Fatal(err)
	}
	if got := logpolicy.LogsDir(logger.Discard); got != state {
		t.Fatalf("SDK escaped private state directory: %s", got)
	}
	info, err := os.Stat(state)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatal("state directory must be private")
	}
}

func TestEndpointRestrictions(t *testing.T) {
	if !validEndpoint("http://100.64.0.1:7691") {
		t.Fatal("valid endpoint rejected")
	}
	for _, endpoint := range []string{"http://127.0.0.1:7691", "http://192.168.1.1:80", "http://100.128.0.1:80", "http://100.64.0.1:0", "http://100.64.0.1:65536", "http://user@100.64.0.1:7691", "http://100.64.0.1:7691/path", "http://example.com:80"} {
		if validEndpoint(endpoint) {
			t.Errorf("unsafe endpoint accepted: %s", endpoint)
		}
	}
}

func TestInterfaceSnapshot(t *testing.T) {
	if err := SetInterfaces(`[{"name":"wlan0","index":2,"mtu":1500,"flags":3,"addresses":["10.0.2.15/24"]}]`); err != nil {
		t.Fatal(err)
	}
	interfaceMu.RLock()
	got := interfaces[0].AltAddrs[0].String()
	interfaceMu.RUnlock()
	if got != "10.0.2.15/24" {
		t.Fatalf("interface host address lost: %s", got)
	}
	if SetInterfaces(`[{"addresses":["invalid"]}]`) == nil {
		t.Fatal("bad snapshot accepted")
	}
}

func TestRequestsFailClosedWithoutNetwork(t *testing.T) {
	client := &Client{}
	for _, path := range []string{"/trpc", "/v1/pair/../status", "/v1/status?token=x", "/v1/approve"} {
		if _, err := client.Request("http://100.64.0.1:7691", path, "GET", "", ""); err == nil {
			t.Errorf("unsafe path accepted: %s", path)
		}
	}
	if _, err := client.Request("http://100.64.0.1:7691", "/v1/status", "GET", "", ""); err == nil {
		t.Fatal("closed client accepted request")
	}
	client.Close()
	client.Close()
}
