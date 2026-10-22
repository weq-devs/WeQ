// Package androidnet 为最小 Android 客户端提供用户态 TS 与受限 HTTP 请求。
package androidnet

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/net/netmon"
	"tailscale.com/tsnet"
	"tailscale.com/types/logger"
)

var interfaceMu sync.RWMutex
var interfaces []netmon.Interface

func init() {
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		interfaceMu.RLock()
		defer interfaceMu.RUnlock()
		return append([]netmon.Interface(nil), interfaces...), nil
	})
}

// SetInterfaces 使用 Android Java API 的快照，避免应用 UID 被禁止访问 netlink。
func SetInterfaces(raw string) error {
	if len(raw) > 65536 {
		return errors.New("interface snapshot too large")
	}
	var input []struct {
		Name      string   `json:"name"`
		Index     int      `json:"index"`
		MTU       int      `json:"mtu"`
		Flags     int      `json:"flags"`
		Addresses []string `json:"addresses"`
	}
	if err := json.Unmarshal([]byte(raw), &input); err != nil || len(input) > 64 {
		return errors.New("invalid interfaces")
	}
	var snapshot []netmon.Interface
	for _, item := range input {
		current := netmon.Interface{Interface: &net.Interface{Name: item.Name, Index: item.Index, MTU: item.MTU, Flags: net.Flags(item.Flags)}, AltAddrs: []net.Addr{}}
		for _, value := range item.Addresses {
			ip, network, err := net.ParseCIDR(value)
			if err != nil {
				return errors.New("invalid interface address")
			}
			network.IP = ip
			current.AltAddrs = append(current.AltAddrs, network)
		}
		snapshot = append(snapshot, current)
	}
	interfaceMu.Lock()
	interfaces = snapshot
	interfaceMu.Unlock()
	return nil
}

type Client struct {
	mu     sync.RWMutex
	server *tsnet.Server
	http   *http.Client
	ctx    context.Context
	cancel context.CancelFunc
}

// NewClient 只用于官方控制面；测试配置从独立的测试 APK 进入。
func NewClient(stateDir string) (*Client, error) { return newClient(stateDir, "") }

// NewTestClient 的目的地址必须是回环控制面；产品界面不暴露这个入口。
func NewTestClient(stateDir, control string) (*Client, error) {
	u, err := url.Parse(control)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Port() == "" || u.Path != "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid test control")
	}
	return newClient(stateDir, control)
}

func prepareStateDir(stateDir string) error {
	if stateDir == "" {
		return errors.New("state directory required")
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return err
	}
	// Android 的 JNI 进程没有常规 HOME/tmp；SDK 即使关闭上传仍需安全的状态目录。
	if err := os.Setenv("TS_LOGS_DIR", stateDir); err != nil {
		return err
	}
	return nil
}

func newClient(stateDir, control string) (*Client, error) {
	if err := prepareStateDir(stateDir); err != nil {
		return nil, err
	}
	envknob.SetNoLogsNoSupport()
	server := &tsnet.Server{Dir: stateDir, Hostname: "weq-remote-android", ControlURL: control, Logf: logger.Discard, UserLogf: logger.Discard}
	if err := server.Start(); err != nil {
		_ = server.Close()
		return nil, errors.New("network start failed")
	}
	transport := &http.Transport{Proxy: nil, DialContext: server.Dial, MaxIdleConns: 4, IdleConnTimeout: 20 * time.Second, ResponseHeaderTimeout: 12 * time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{server: server, ctx: ctx, cancel: cancel, http: &http.Client{Transport: transport, Timeout: 15 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (c *Client) Status() (string, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.server == nil {
		return "", errors.New("network closed")
	}
	local, err := c.server.LocalClient()
	if err != nil {
		return "", errors.New("network unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	status, err := local.Status(ctx)
	if err != nil {
		return "", errors.New("network status failed")
	}
	data, err := json.Marshal(struct {
		State     string       `json:"state"`
		LoginURL  string       `json:"loginURL"`
		Addresses []netip.Addr `json:"addresses"`
	}{status.BackendState, status.AuthURL, status.TailscaleIPs})
	return string(data), err
}

func validEndpoint(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	host, port, err := net.SplitHostPort(u.Host)
	if err != nil || port == "" {
		return false
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return false
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && netip.MustParsePrefix("100.64.0.0/10").Contains(ip)
}

var claimPath = regexp.MustCompile(`^/v1/pair/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

// Request 不提供任意网络代理：仅接受配对和只读状态路径。
func (c *Client) Request(endpoint, path, method, token, body string) (string, error) {
	if !validEndpoint(endpoint) {
		return "", errors.New("invalid tailnet endpoint")
	}
	if !(method == "POST" && path == "/v1/pair" || method == "GET" && (path == "/v1/status" || claimPath.MatchString(path))) || len(body) > 4096 {
		return "", errors.New("invalid remote request")
	}
	c.mu.RLock()
	client := c.http
	c.mu.RUnlock()
	if client == nil {
		return "", errors.New("network closed")
	}
	request, err := http.NewRequestWithContext(c.ctx, method, endpoint+path, strings.NewReader(body))
	if err != nil {
		return "", errors.New("request failed")
	}
	request.Header.Set("Accept", "application/json")
	if method == "POST" {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		if len(token) != 64 || strings.Trim(token, "0123456789abcdef") != "" {
			return "", errors.New("invalid credential")
		}
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("连接失败，请检查网络及电脑状态")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(data) > 65536 {
		return "", errors.New("invalid remote response")
	}
	output, err := json.Marshal(struct {
		Status int    `json:"status"`
		Body   string `json:"body"`
	}{response.StatusCode, string(data)})
	return string(output), err
}

func (c *Client) Close() {
	c.mu.Lock()
	server, client := c.server, c.http
	c.server, c.http = nil, nil
	if c.cancel != nil {
		c.cancel()
	}
	c.mu.Unlock()
	if client != nil {
		client.CloseIdleConnections()
	}
	if server != nil {
		_ = server.Close()
	}
}
