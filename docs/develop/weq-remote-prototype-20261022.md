# WeQ Remote 电脑端原型（2026-10-22）

## 范围与入口

设置 → 服务与集成 → WeQ Remote。默认关闭，不改变系统 VPN，不修改现有 Tailscale。

已实现：独立 tsnet 节点、网络登录入口、真实一次性二维码、电脑确认、设备凭据认证与撤销。
远程 API 只提供在线状态；没有挂载现有 tRPC router，不开放聊天记录、文件、QQ 操作或管理功能。
设备授权只在本次运行内存保存；关闭远程服务、网络掉线、退出应用均清除授权，之后需重新配对。
TS 节点身份另存在应用 userData 下的 `remote-network`，再次启用不一定需要重新登录。

后续已增加 [iOS 0.1.0 最小开发客户端](../../apps/ios/README.md) 和 [Android 0.1.0 开发测试包](../../apps/android/README.md)，可扫码或粘贴配对链接验证在线状态；电脑可在有效二维码旁复制链接。它们不是商店正式发布版，也不是免账号扫码入网方案：两端仍须先加入同一 tailnet，并由网络策略允许访问电脑节点。自动入网配对服务、Headscale 多用户隔离、后台通知及持久设备授权仍未实现。

## 构建与运行

复用本机 Go 工具链及模块缓存；不下载原生 QQ 模块、不启动额外 QQ 或改动现用服务。

```sh
cd /Users/wata4me/Projects/WeQ-upstream/tools/remote-network
go build -o weq-remote-network .
cd /Users/wata4me/Projects/WeQ-upstream
WEQ_REMOTE_HELPER="$PWD/tools/remote-network/weq-remote-network" pnpm --filter @weq/desktop dev
```

这是源码开发原型，正式安装包尚未集成 helper 的多平台构建、签名与分发。用户手动打开开关后才启动节点并可能访问官方控制面；构建与单测不入网注册设备。
辅助进程支持手动 `--control https://...` 指定自托管控制面，桌面界面暂未提供该配置。

## 配对协议 v1

二维码：`weq-remote://pair?v=1&endpoint=<tailnet-http-origin>&invitation=<一次性随机邀请>`。
这里的 HTTP 在 tsnet/WireGuard 加密通道内传输，不得改用公网明文或普通局域网地址。
二维码有效期 120 秒；刷新立即使旧邀请及待确认请求失效。二维码包含一次性秘密，不得上传、截图分享或记录到日志。

测试客户端在本地生成 32 字节随机凭据，以 64 字符小写 hex 保存（不得上传第三方）：

1. `POST /v1/pair`，JSON `{ invitation, name, tokenHash }`，其中 `tokenHash = SHA256(凭据hex字符串)`。
2. 返回 `{ id, code, expiresAt }`。两端核对六位校验码，电脑批准。名称不是可信身份，不能只看名称批准。
3. 带 `Authorization: Bearer <凭据>` 请求 `GET /v1/pair/<id>` 查询 `approved`。
4. 批准后，同样带凭据请求 `GET /v1/status`。撤销后立即返回 401。

没有通过网络批准设备的接口；仅桌面 IPC 能批准和撤销。网页 tRPC 管理调用被拒绝。
最多 16 台设备；请求体限制 4 KiB；全局 120 请求/分钟；不接受 Origin/CORS；凭据仅保留 SHA256 摘要，不在 URL 中传输。
当前依赖 tailnet 的设备身份与访问策略，不实现额外应用层端到端身份握手。正式跨租户版本需重新审查设备身份绑定、入网隔离与权限策略。

## 验证

```sh
pnpm --filter @weq/desktop exec vitest run test/remote_pairing.test.ts test/remote_http.test.ts test/remote_runtime.test.ts test/remote_panel.test.ts test/settings_navigation.test.ts
pnpm --filter @weq/desktop typecheck
```

真实跨网、手机扫码、DERP 路径、切网恢复、耗电和正式签名安装包需后续真机验收，单测通过不代表这些已完成。

2026-10-22 本机验证：上述 15 项针对性测试通过；Go 辅助程序构建及 `go vet ./...` 通过。
浏览器使用真实面板组件和明确标注的测试状态，检查浅色、深色、390px 窄视口、自定义主题色、批准、撤销和关闭；浏览器已正常关闭。界面截图不是已连上手机的证据。
首次完整桌面类型检查的 Node 部分通过，Web 部分曾被在途的 `lib/backupClientRestore.ts:38` 泛型 Promise 类型错误阻断；未修改该备份代码。其他在途改动更新后，最终重跑完整桌面 Node/Web 类型检查均通过。
