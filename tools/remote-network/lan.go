package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"
)

// 固定证书随节点身份保存；二维码携带指纹，手机不信任任意自签名证书。
func lanCertificate(dir string) (tls.Certificate, error) {
	path := filepath.Join(dir, "lan-identity.pem")
	if data, err := os.ReadFile(path); err == nil {
		return tls.X509KeyPair(data, data)
	} else if !os.IsNotExist(err) {
		return tls.Certificate{}, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "WeQ Remote"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(20, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	raw, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	data := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw})...)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return tls.Certificate{}, err
	}
	return tls.X509KeyPair(data, data)
}

func runLAN(ctx context.Context, dir string, port int, handler http.Handler, ready func(event)) error {
	cert, err := lanCertificate(dir)
	if err != nil {
		return err
	}
	listener, err := tls.Listen("tcp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)), &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12})
	if err != nil {
		return err
	}
	restricted := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		ip := net.ParseIP(host).To4()
		if err != nil || ip == nil || !(ip.IsPrivate() || ip.IsLoopback() || (ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127)) {
			http.Error(w, "private network required", http.StatusForbidden)
			return
		}
		handler.ServeHTTP(w, r)
	})
	server := &http.Server{Handler: restricted, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	defer server.Close()
	boundPort := strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
	addresses := []string{}
	interfaces, err := net.InterfaceAddrs()
	if err != nil {
		return err
	}
	for _, address := range interfaces {
		ip, _, err := net.ParseCIDR(address.String())
		if err == nil && ip.To4() != nil && !ip.IsLoopback() && (ip.IsPrivate() || (ip.To4()[0] == 100 && ip.To4()[1] >= 64 && ip.To4()[1] <= 127)) {
			addresses = append(addresses, "https://"+ip.String()+":"+boundPort)
		}
	}
	sort.SliceStable(addresses, func(i, j int) bool {
		return net.ParseIP(mustLANHost(addresses[i])).IsPrivate() && !net.ParseIP(mustLANHost(addresses[j])).IsPrivate()
	})
	digest := sha256.Sum256(cert.Certificate[0])
	ready(event{State: "online", Addresses: addresses, Fingerprint: hex.EncodeToString(digest[:])})
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		return nil
	case err := <-done:
		return err
	}
}

func mustLANHost(address string) string { value, _ := url.Parse(address); return value.Hostname() }
