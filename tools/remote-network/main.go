// WeQ 专用用户态网络节点；只代理本机的最小配对 API，不接管系统网络。
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

type event struct {
	State   string `json:"state"`
	AuthURL string `json:"authUrl,omitempty"`
	Address string `json:"address,omitempty"`
	Error   string `json:"error,omitempty"`
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
	control := flag.String("control", "", "可选的自托管控制面地址")
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
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	// 父进程退出或管道关闭时结束，不遗留独立节点进程。
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	srv := &tsnet.Server{
		Dir: *state, Hostname: "weq-remote", ControlURL: *control,
		Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {},
	}
	defer srv.Close()
	lc, err := srv.LocalClient()
	if err != nil {
		return err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{Proxy: nil, MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "backend unavailable", http.StatusBadGateway)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/pair" && r.URL.Path != "/v1/status" && !strings.HasPrefix(r.URL.Path, "/v1/pair/") {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		proxy.ServeHTTP(w, r)
	})
	var server *http.Server
	defer func() {
		if server != nil {
			_ = server.Close()
		}
	}()
	previous := event{}
	encoder := json.NewEncoder(os.Stdout)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		status, err := lc.Status(ctx)
		next := event{State: "offline"}
		if err == nil {
			if status.AuthURL != "" {
				next = event{State: "login", AuthURL: status.AuthURL}
			}
			if status.BackendState == "Running" && len(status.TailscaleIPs) > 0 {
				if server == nil {
					ln, err := srv.Listen("tcp", ":7691")
					if err != nil {
						return err
					}
					server = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
					go func() {
						if err := server.Serve(ln); err != http.ErrServerClosed {
							cancel()
						}
					}()
				}
				for _, ip := range status.TailscaleIPs {
					if ip.Is4() {
						next = event{State: "online", Address: fmt.Sprintf("http://%s:7691", ip)}
						break
					}
				}
			}
		}
		if next != previous {
			if err := encoder.Encode(next); err != nil {
				return err
			}
			previous = next
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
