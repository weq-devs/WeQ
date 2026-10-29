# OneBot 多 WS / HTTP 服务器实施记录

2026-10-30（北京时间）。在现有 OneBot / cc-connect 服务上增加多监听器，不调整版本号，
未连接真实 QQ、OneBot 客户端或外部网络服务完成验收。

## 配置与兼容

- `OneBotConfig` 从单个 `port` / `token` 改为 `webSocketServers[]` 与 `httpServers[]`；
  `enabled` 保留为总开关，每个服务器另有独立 `enabled`。
- 旧版 `{ enabled, port, token }` 在读取配置时迁移为一张 `webSocketServers[0]`，保留原端口
  和令牌；配置备份校验同时接受旧格式和新格式。
- 每个服务器使用稳定 `id` 对应运行状态，便于界面在轮询状态时准确显示每张卡片。

## 运行实现

- `OneBotServer` 共享动作分发、消息登记和短期媒体索引，但为每条配置创建独立 HTTP
  listener；WS listener 处理正向连接，HTTP listener 处理标准 `/action` 调用。
- HTTP 支持 GET 查询参数、POST JSON 参数、统一 `action/params/echo` 请求体和可选 CORS；
  Bearer 与 `access_token` 查询参数均可鉴权。
- 监听器按配置顺序启动。遇到 `EADDRINUSE` 时最多顺延 20 个端口；单项失败只记录到该项
  状态，不影响其他服务器，实际端口会回传界面。
- HTTP listener 只承载 action，不主动推送事件；消息事件继续通过 WS `/`、`/event`
  或 API-only `/api` 发送。

## 界面

- OneBot 设置页改为窄卡片网格，WS 与 HTTP 使用不同图标和类型标签。
- 每张卡片独立启停、编辑、复制地址/令牌、重新生成令牌和删除；新建 HTTP 卡片可配置 CORS。
- 端口顺延、等待账号、总开关关闭及单项启动失败均直接显示在对应卡片。

## 定向回归

```sh
pnpm --dir packages/service exec vitest run test/onebot_config.test.ts test/backup_restore.test.ts
pnpm --dir apps/desktop exec vitest run test/onebot_server.test.ts test/onebot_runtime.test.ts test/onebot_settings.test.ts
pnpm --filter @weq/service typecheck
pnpm --filter @weq/desktop typecheck
```

测试使用合成账号、合成消息和回环 HTTP/WS 监听，覆盖旧配置迁移、多服务器配置、HTTP action、
鉴权、CORS、端口顺延、运行状态和卡片增删启停。
