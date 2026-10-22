package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

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
