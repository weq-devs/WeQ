// 只供本机 iOS 集成测试：隔离的控制面和 DERP，不连接公共 tailnet。
package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/envknob"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "iOS isolated TS test network failed:", err)
		os.Exit(1)
	}
}

func run() error {
	envknob.SetNoLogsNoSupport()
	helper := flag.String("helper", "", "已构建的正式网络辅助程序")
	config := flag.String("config", "", "测试配置输出文件，不含密钥")
	both := flag.Bool("both", false, "同时验证局域网与 TS HTTPS 入口")
	flag.Parse()
	if *helper == "" || *config == "" {
		return fmt.Errorf("helper and config required")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	relay := derpserver.New(key.NewNode(), logger.Discard)
	defer relay.Close()
	relayHTTP := httptest.NewTLSServer(derpserver.Handler(relay))
	defer relayHTTP.Close()
	relayURL, _ := url.Parse(relayHTTP.URL)
	port, _ := strconv.Atoi(relayURL.Port())
	control := &testcontrol.Server{
		Logf: logger.Discard, AllNodesSameUser: true, AllOnline: true,
		DERPMap: &tailcfg.DERPMap{Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{1: {
			RegionID: 1, RegionCode: "localtest", RegionName: "Local iOS test",
			Nodes: []*tailcfg.DERPNode{{Name: "localtest", RegionID: 1, HostName: "127.0.0.1", IPv4: "127.0.0.1", DERPPort: port, STUNPort: -1, InsecureForTests: true}},
		}}},
	}
	control.HTTPTestServer = httptest.NewServer(control)
	defer control.HTTPTestServer.Close()
	state, err := os.MkdirTemp(filepath.Dir(*config), "test-network-state-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(state)
	cmd := exec.Command(*helper, "--backend", "http://127.0.0.1:45198", "--control", control.HTTPTestServer.URL, "--state", state)
	if *both {
		cmd.Args = append(cmd.Args, "--mode", "both", "--lan-port", "0")
	}
	// 测试节点的状态与日志不发送到公共日志服务。
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "TS_AUTHKEY=") && !strings.HasPrefix(value, "TS_NO_LOGS_NO_SUPPORT=") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "TS_NO_LOGS_NO_SUPPORT=true")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer func() {
		_ = stdin.Close()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	}()
	defer os.Remove(*config)
	scanner := bufio.NewScanner(output)
	type networkEvent struct {
		State       string   `json:"state"`
		Address     string   `json:"address"`
		Fingerprint string   `json:"fingerprint"`
		Addresses   []string `json:"addresses"`
	}
	ready := make(chan networkEvent, 1)
	go func() {
		for scanner.Scan() {
			var event networkEvent
			if json.Unmarshal(scanner.Bytes(), &event) == nil && event.State == "online" {
				select {
				case ready <- event:
				default:
				}
			}
		}
	}()
	select {
	case event := <-ready:
		if *both {
			peer := &tsnet.Server{Dir: filepath.Join(state, "probe"), Hostname: "weq-https-test", ControlURL: control.HTTPTestServer.URL, Logf: logger.Discard, UserLogf: logger.Discard}
			defer peer.Close()
			probeContext, stop := context.WithTimeout(ctx, 30*time.Second)
			defer stop()
			if _, err := peer.Up(probeContext); err != nil {
				return err
			}
			address, _ := url.Parse(event.Address)
			transport := &http.Transport{Proxy: nil, DialContext: peer.Dial, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(connection tls.ConnectionState) error {
				if len(connection.PeerCertificates) == 0 {
					return fmt.Errorf("TLS certificate missing")
				}
				digest := sha256.Sum256(connection.PeerCertificates[0].Raw)
				if hex.EncodeToString(digest[:]) != event.Fingerprint {
					return fmt.Errorf("TLS pin mismatch")
				}
				return nil
			}}}
			defer transport.CloseIdleConnections()
			request, _ := http.NewRequestWithContext(probeContext, "GET", "https://"+address.Hostname()+":7692/v1/status", nil)
			response, err := (&http.Client{Transport: transport, Timeout: 15 * time.Second}).Do(request)
			if err != nil {
				return err
			}
			response.Body.Close()
			if response.StatusCode != http.StatusUnauthorized {
				return fmt.Errorf("TS HTTPS did not require device credential")
			}
		}
		data, _ := json.Marshal(map[string]string{"endpoint": event.Address, "control": control.HTTPTestServer.URL, "relayPort": strconv.Itoa(port)})
		if err := os.WriteFile(*config, data, 0600); err != nil {
			return err
		}
		fmt.Println("Isolated TS control/DERP and production desktop helper ready (no public registration)")
	case <-time.After(40 * time.Second):
		return fmt.Errorf("desktop node did not become ready")
	case <-ctx.Done():
		return nil
	}
	<-ctx.Done()
	return nil
}
