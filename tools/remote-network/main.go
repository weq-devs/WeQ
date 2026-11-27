// WeQ 专用网络入口；转发本机配对与已授权 Web，不接管系统网络。
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

type event struct {
	State       string   `json:"state"`
	AuthURL     string   `json:"authUrl,omitempty"`
	Address     string   `json:"address,omitempty"`
	Error       string   `json:"error,omitempty"`
	Addresses   []string `json:"addresses,omitempty"`
	Fingerprint string   `json:"fingerprint,omitempty"`
}

func main() {
	if err := run(); err != nil {
		_ = json.NewEncoder(os.Stdout).Encode(event{State: "error", Error: "网络节点启动失败，请检查网络和控制面配置。"})
		os.Exit(1)
	}
}

func run() error {
	backend := flag.String("backend", "", "本机配对 HTTP 服务")
	state := flag.String("state", "", "节点身份存储目录")
	lanState := flag.String("lan-state", "", "可选的稳定局域网证书目录")
	lanPort := flag.Int("lan-port", 7691, "局域网端口；0 用于隔离测试")
	control := flag.String("control", "", "可选的自托管控制面地址")
	mode := flag.String("mode", "tailscale", "lan、tailscale 或 both")
	flag.Parse()
	target, err := url.Parse(*backend)
	if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.Port() == "" || target.Path != "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" {
		return fmt.Errorf("backend must be a loopback HTTP origin")
	}
	if *state == "" {
		return fmt.Errorf("state directory required")
	}
	if err := os.MkdirAll(*state, 0700); err != nil {
		return err
	}
	setupControlDial(*control)
	if *lanState == "" {
		*lanState = *state
	}
	if err := os.MkdirAll(*lanState, 0700); err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// 父进程退出或管道关闭时结束，不遗留独立节点进程。
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	proxy := newBackendProxy(target)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 后端对配对和 Web 分别鉴权；允许 WebSocket、媒体 Range 及正常 Web 方法。
		r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
		proxy.ServeHTTP(w, r)
	})
	lan := event{}
	encoder := json.NewEncoder(os.Stdout)
	// 状态事件可能来自主循环和 UserLogf 两个 goroutine；串行化输出、保留最新登录链接并按内容去重。
	var emitMu sync.Mutex
	lastAuthURL := ""
	previous := event{}
	emit := func(value event) {
		emitMu.Lock()
		defer emitMu.Unlock()
		if value.AuthURL != "" {
			lastAuthURL = value.AuthURL
		} else if value.State == "login" {
			value.AuthURL = lastAuthURL
		}
		if value.State == previous.State && value.AuthURL == previous.AuthURL && value.Address == previous.Address && value.Error == previous.Error {
			return
		}
		_ = encoder.Encode(value)
		previous = value
	}
	if *mode == "lan" || *mode == "both" {
		ready := make(chan event, 1)
		failed := make(chan error, 1)
		go func() { failed <- runLAN(ctx, *lanState, *lanPort, handler, func(value event) { ready <- value }) }()
		select {
		case lan = <-ready:
		case err := <-failed:
			return err
		case <-ctx.Done():
			return nil
		}
		if *mode == "lan" {
			if err := encoder.Encode(lan); err != nil {
				return err
			}
			select {
			case err := <-failed:
				return err
			case <-ctx.Done():
				return nil
			}
		}
		lan.State = "starting"
		if err := encoder.Encode(lan); err != nil {
			return err
		}
		go func() {
			select {
			case <-failed:
				cancel()
			case <-ctx.Done():
			}
		}()
	}
	srv := &tsnet.Server{Dir: *state, Hostname: "weq-remote", ControlURL: *control, Logf: func(string, ...any) {}, UserLogf: func(format string, args ...any) {
		// tsnet 的登录链接只出现在用户日志里；丢弃它会让界面永远停在「已停止」且无法登录。
		if loginURL := loginURLFromMessage(fmt.Sprintf(format, args...)); loginURL != "" {
			emit(event{State: "login", AuthURL: loginURL})
		}
	}}
	defer srv.Close()
	lc, err := srv.LocalClient()
	if err != nil {
		return err
	}
	var server *http.Server
	var secureServer *http.Server
	defer func() {
		if server != nil {
			_ = server.Close()
		}
		if secureServer != nil {
			_ = secureServer.Close()
		}
	}()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		status, err := lc.Status(ctx)
		next := event{State: "offline"}
		if err != nil {
			// 控制面不可达时必须把原因透传，否则界面只会静默显示「已停止」。
			if ctx.Err() == nil {
				next.Error = fmt.Sprintf("无法获取 Tailscale 状态：%v", err)
			}
		} else {
			if status.AuthURL != "" {
				next = event{State: "login", AuthURL: status.AuthURL}
			} else if status.BackendState == "NeedsLogin" {
				// 尚未拿到登录链接时也上报 login，让界面显示「等待登录」而不是「已停止」。
				next = event{State: "login"}
			}
			if status.BackendState == "Running" && len(status.TailscaleIPs) > 0 {
				if server == nil {
					ln, err := srv.Listen("tcp", ":7691")
					if err != nil {
						return err
					}
					server = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
					go func() {
						if err := server.Serve(ln); err != http.ErrServerClosed {
							cancel()
						}
					}()
					if *mode == "both" || *mode == "tailscale" {
						cert, err := lanCertificate(*lanState)
						if err != nil {
							return err
						}
						secure, err := srv.Listen("tcp", ":7692")
						if err != nil {
							return err
						}
						secureServer = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
						go func() {
							if err := secureServer.Serve(tls.NewListener(secure, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})); err != http.ErrServerClosed {
								cancel()
							}
						}()
					}
				}
				for _, ip := range status.TailscaleIPs {
					if ip.Is4() {
						next = event{State: "online", Address: fmt.Sprintf("http://%s:7691", ip)}
						break
					}
				}
			}
		}
		next.Addresses = append([]string(nil), lan.Addresses...)
		next.Fingerprint = lan.Fingerprint
		if *mode == "both" && next.State == "online" {
			address, _ := url.Parse(next.Address)
			next.Addresses = append(next.Addresses, "https://"+address.Hostname()+":7692")
		}
		emit(next)
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// loginURLFromMessage 从 tsnet 的用户日志里取出登录链接（例如「go to: https://…/a/xxx」）。
func loginURLFromMessage(message string) string {
	lowered := strings.ToLower(message)
	if !strings.Contains(lowered, "login") && !strings.Contains(lowered, "authenticate") {
		return ""
	}
	const marker = "https://"
	index := strings.Index(message, marker)
	if index < 0 {
		return ""
	}
	length := strings.IndexAny(message[index:], " \t\r\n\"'")
	if length < 0 {
		length = len(message) - index
	}
	return message[index : index+length]
}

// controlPlaneHost 从控制面地址取出主机名；默认控制面在 tailscale.com 域下。
func controlPlaneHost(control string) string {
	if control != "" {
		if parsed, err := url.Parse(control); err == nil && parsed.Hostname() != "" {
			return parsed.Hostname()
		}
	}
	return "controlplane.tailscale.com"
}

// setupControlDial 优选控制面的连接路径。启动终端里遗留的代理变量往往只对浏览器
// 流量有效：代理不可达时 tsnet 的控制面连接会一直失败，界面只会静默显示已停止。
// 直连可用时用 NO_PROXY 按域绕过代理；直连不可用而代理可用时保留代理变量。
func setupControlDial(control string) {
	const probe = "/key?v=148"
	host := controlPlaneHost(control)
	hostname := host
	direct := &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 5 * time.Second}).DialContext},
	}
	if resp, err := direct.Get("https://" + hostname + probe); err == nil {
		resp.Body.Close()
		// tailscale.com 后缀同时覆盖登录与 DERP 相关子域。
		os.Setenv("NO_PROXY", "tailscale.com")
		os.Setenv("no_proxy", "tailscale.com")
		return
	}
	if hostname != "controlplane.tailscale.com" {
		return
	}
	// 直连不通时清掉绕过项，让 tsnet 沿用代理环境变量（若代理可用）。
	os.Unsetenv("NO_PROXY")
	os.Unsetenv("no_proxy")
	proxied := &http.Client{Timeout: 5 * time.Second}
	if resp, err := proxied.Get("https://" + hostname + probe); err == nil {
		resp.Body.Close()
	}
}

func newBackendProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	// 仅限制建连与空闲连接；业务等待随请求取消，不截断慢查询和订阅。
	proxy.Transport = &http.Transport{
		Proxy:               nil,
		DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "backend unavailable", http.StatusBadGateway)
	}
	return proxy
}
