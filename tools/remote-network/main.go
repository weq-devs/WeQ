// WeQ 专用网络入口；转发本机配对与已授权 Web，不接管系统网络。
package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
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
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{Proxy: nil, MaxIdleConns: 4, IdleConnTimeout: 30 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "backend unavailable", http.StatusBadGateway)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 后端对配对和 Web 分别鉴权；允许 WebSocket、媒体 Range 及正常 Web 方法。
		r.Body = http.MaxBytesReader(w, r.Body, 32<<20)
		proxy.ServeHTTP(w, r)
	})
	lan := event{}
	encoder := json.NewEncoder(os.Stdout)
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
	srv := &tsnet.Server{Dir: *state, Hostname: "weq-remote", ControlURL: *control, Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
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
	previous := event{}
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
					server = &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
					go func() {
						if err := server.Serve(ln); err != http.ErrServerClosed {
							cancel()
						}
					}()
					if *mode == "both" {
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
		if next.State != previous.State || next.AuthURL != previous.AuthURL || next.Address != previous.Address {
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
