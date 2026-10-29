# OneBot / cc-connect

WeQ 可以提供 OneBot v11 正向 WebSocket 接口，直接连接 cc-connect 的 `qq` 通道。
QQ 收发由 WeQ 完成，Agent 与会话仍由 cc-connect 管理，不需要额外启动 NapCat。

## 连接

1. 在 QQ 登录目标账号，并在 WeQ 打开对应的在线账号。
2. 打开「设置 → WeQ 服务 → OneBot / cc-connect」，启用服务。
3. 点击「复制 cc-connect 配置」，加入 cc-connect 对应项目的配置中，将 `allow_from` 改为发起命令的用户 QQ 号。
4. 把原 `qq` 通道的地址、令牌替换为 WeQ 的值；不要为同一项目重复创建两个 QQ 通道。
5. 按 cc-connect 的正常流程重载配置，检查 WeQ 页面连接数，并用另一个 QQ 账号发送私聊或群内 @ 测试。

配置片段如下，项目名与 Agent 配置沿用原值：

```toml
[[projects.platforms]]
type = "qq"

[projects.platforms.options]
ws_url = "ws://127.0.0.1:48766"
token = "替换为 WeQ 页面生成的访问令牌"
allow_from = "填写你的 QQ 号"
group_require_mention = true
```

保留原通道的其他会话配置。旧 `http_url` 指向 NapCat 时应删除；此接口的发送操作走同一个 WebSocket。
WeQ 与 cc-connect 需要运行在同一台电脑。接口固定监听 `127.0.0.1`，默认端口为 `48766`；端口冲突会明确报错，不会自动换到另一个地址。

## 当前支持

- 私聊、群聊新消息，群内原生 @。
- 文本与引用回复；私聊引用使用发送方的 `clientSeq`，不使用会话分页序号。
- cc-connect 发送图片、群文件与私聊文件；Base64 或本机绝对路径，单文件最大 16 MiB。
- 接收本机已经缓存的图片、语音和文件；图片缺失时尝试复用 WeQ 下载服务。无法取得媒体时提供文本占位。
- 本机媒体由短期回环 URL 提供给 cc-connect，不需要 NapCat 的文件下载 API。
- 私聊输入状态、登录资料、群名称、当前桥接会话缓存中的消息查询。

这是 cc-connect 所需的兼容子集，不是 NapCat 的完整替代实现。暂不包含 HTTP action 接口、反向 WebSocket、管理类 action、语音/视频发送及未缓存文件的在线补全。
文件走独立上传管线，不能与正文/图片混发，也不附带 QQ 原生引用；cc-connect 的文件发送仍可正常使用。

## 运行行为

服务默认关闭，打开在线账号后按设置启动；关闭、切换账号或退出 WeQ 会断开连接并卸载监听。
备份账号不启动服务。监听复用 WeQ 的数据库增量检测，但独立于界面的「实时消息」开关。
如果切换到另一个 QQ 账号，请重启或重载 cc-connect 的 QQ 通道并选择相应 Agent 会话；当前 cc-connect 的自动重连不会重新读取登录账号。
首次监听只建立基线，不重放历史；断线期间不保证补投，重新连接后的新消息继续上报。原生 QQ 登录及 WeQ 在线收发能力仍需保持可用。

QQ 原始 `msgId` 为 64 位，接口映射为稳定的有符号 32 位 ID，兼容 cc-connect 的引用上下文；每个实例最多保存 4096 条映射。
引用已淘汰、来自其他会话或缺少必要序号的消息会返回错误，不退化成无引用发送。QQ 拒绝发送时返回失败，不自动重发。

OneBot 配置跟随全局配置保存；配置备份时与 MCP 一样进入 API 配置分区。
