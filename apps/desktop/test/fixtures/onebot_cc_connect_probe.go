// 从 cc-connect 源码目录 go run 本文件；只连接测试提供的回环 WebSocket。
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/chenhg5/cc-connect/core"
	"github.com/chenhg5/cc-connect/platform/qq"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	p, err := qq.New(map[string]any{"ws_url": os.Args[1], "token": "synthetic-token", "allow_from": "7", "group_require_mention": true})
	if err != nil {
		return err
	}
	defer p.Stop()
	result := make(chan error, 1)
	if err := p.Start(func(platform core.Platform, msg *core.Message) {
		if msg.Content != "hello" || msg.UserID != "7" || msg.SessionKey != "qq:42:7" {
			result <- fmt.Errorf("unexpected incoming message: %#v", msg)
			return
		}
		if len(msg.Images) != 1 || msg.Images[0].MimeType != "image/png" || len(msg.Files) != 1 || string(msg.Files[0].Data) != "synthetic file" {
			result <- fmt.Errorf("incoming media mismatch")
			return
		}
		ctx := context.Background()
		if err := platform.Reply(ctx, msg.ReplyCtx, "response"); err != nil {
			result <- err
			return
		}
		if err := platform.(core.ImageSender).SendImage(ctx, msg.ReplyCtx, msg.Images[0]); err != nil {
			result <- err
			return
		}
		if err := platform.(core.FileSender).SendFile(ctx, msg.ReplyCtx, msg.Files[0]); err != nil {
			result <- err
			return
		}
		result <- nil
	}); err != nil {
		return err
	}
	fmt.Println("READY")
	select {
	case err := <-result:
		if err == nil {
			fmt.Println("PASS")
		}
		return err
	case <-time.After(15 * time.Second):
		return fmt.Errorf("cc-connect probe timed out")
	}
}
