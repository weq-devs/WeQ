// 只供本机 iOS 集成测试：隔离的控制面和 DERP，不连接公共 tailnet。
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
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
	"tailscale.com/tailcfg"
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
	helper := flag.String("helper", "", "已构建的正式网络辅助程序")
	config := flag.String("config", "", "测试配置输出文件，不含密钥")
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
	ready := make(chan string, 1)
	go func() {
		for scanner.Scan() {
			var event struct {
				State   string `json:"state"`
				Address string `json:"address"`
			}
			if json.Unmarshal(scanner.Bytes(), &event) == nil && event.State == "online" {
				select {
				case ready <- event.Address:
				default:
				}
			}
		}
	}()
	select {
	case address := <-ready:
		data, _ := json.Marshal(map[string]string{"endpoint": address, "control": control.HTTPTestServer.URL, "relayPort": strconv.Itoa(port)})
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
