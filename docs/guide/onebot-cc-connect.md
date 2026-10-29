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
- 私聊输入状态、登录资料、群名称与可回查的消息查询。

除 cc-connect 收发外，正向 WebSocket 还提供以下常用接口：

- 名单：`get_friend_list`、`get_group_list`。
- 群管理：`set_group_name`、`set_group_card`、`set_group_ban`、`set_group_whole_ban`、`set_group_kick`、`set_group_admin`。
- 群文件：`get_group_root_files`、`get_group_files_by_folder`、`get_group_file_system_info`、`get_group_file_url`、`delete_group_file`、`rename_group_file`、`move_group_file`、`create_group_file_folder`、`delete_group_folder`（兼容 `delete_group_file_folder`）。上传可传 `folder` / `folder_id`，回包包含 `file_id`。
- 互动：`set_friend_remark`、`set_group_remark`、`send_poke`（兼容 `friend_poke` / `group_poke`）、`mark_private_msg_as_read`、`mark_group_msg_as_read`、`get_group_at_all_remain`。
- 能力：`get_status`、`get_version_info`、`can_send_image`、`can_send_record`。语音发送尚未接入，能力查询返回 false。
- 消息操作：`get_msg` 回查完整正文，`delete_msg` 撤回，`set_msg_emoji_like` 对群消息添加/取消表情回应。
- 资料：`get_group_info`、`get_group_member_info`、`get_group_member_list`。群资料包含人数和容量；`no_cache=true` 对群资料直接在线查询，对成员资料强制刷新成员目录并保留并发合并。性别、年龄、地区来自本地 Profile（`profile_source=local_cache`）；未建模的 `title_expire_time`、`unfriendly`、`card_changeable` 返回 `null` 并列入 `unavailable_fields`，不伪造为永久头衔或可改名片。
- 合并转发：`get_forward_msg`、`send_group_forward_msg`、`send_private_forward_msg`，支持自定义节点、已登记消息 ID 引用节点和嵌套节点。每次最多 200 个节点、8 层，沿用当前桥接的文本、@、图片、引用及 forward 消息段；未接的消息段明确报错，不静默丢弃。图片可复用当前有效的本机媒体 URL；单文件 16 MiB、单次媒体总量 64 MiB。
- 历史：`get_group_msg_history`、`get_friend_msg_history`，用法见下节。

消息输入接受 CQ 字符串、消息段数组或单个消息段对象；布尔参数接受布尔值及 `true/false`、`1/0`、`yes/no`。`send_msg` 不传 `message_type` 时按唯一目标 ID 推断。
`/` 同时承载 API 和事件，`/api` 只处理 API，`/event` 只推事件。新增 action 不会自动变成 cc-connect Agent 的工具，需由调用方接入使用。

这是实用兼容子集，不是 NapCat 的完整替代实现。暂不包含 HTTP action 接口、反向 WebSocket、语音/视频发送及未缓存文件的在线补全。
文件走独立上传管线，不能与正文/图片混发，也不附带 QQ 原生引用；cc-connect 的文件发送仍可正常使用。

## 历史与转发

历史查询传 `group_id` / `user_id`，`count` 默认 20、最大 200。默认读取本地与已缓存的漫游记录，不自动联网补全；媒体未缓存时保留消息段并标注 `available=false`。

- 省略 `message_seq` 或传 0：从最新记录开始；传已返回的负数 `message_id` / `next_message_seq`：以该消息身份为锚点续页，不重复锚点。正数 uint32 按原生会话序号理解；更大的十进制字符串按本地真实消息 ID 回查，勿转成 JS number。
- `reverse_order=false`（默认）向更早读取，`true` 向更新读取，兼容 `reverseOrder` 别名。返回的 `messages` 始终按时间线正序排列。可选 `start_seq` / `end_seq` 限制会话序号区间。
- `next_message_seq` 直接作为下次请求的锚点；`has_more` 表示本地和当前缓存中还有记录，不代表 QQ 服务端完整历史覆盖情况。私聊采用会话 `msgSeq` 分页，绝不使用引用 `clientSeq`。
- 需要在线补全时显式传 `fetch_remote=true`，同时给明确锚点或 `end_seq`。每次检查最多 `count` 个序号的窗口，空窗口继续沿服务返回游标前进；`network_requested` 回显是否派发了网络请求，不保证所有缺口都有记录。

发送合并转发的 `messages` 使用 node 消息段数组，例如：

```json
{
  "action": "send_group_forward_msg",
  "params": {
    "group_id": 12345,
    "messages": [
      { "type": "node", "data": { "user_id": "67890", "nickname": "成员", "content": "一条消息" } }
    ]
  }
}
```

`node.data.id` 可引用现有消息；自定义节点也兼容 `uin` / `name`。节点的 `content` 可以是 CQ 字符串、消息段数组或单段对象；嵌套节点的 content 使用纯 node 数组。回包含 `message_id` 与 `forward_id`，后者可传给 `get_forward_msg` 的 `id`；本地缓存命中时直接展开，否则复用在线长消息读取。转发内部的引用提示没有原会话定位时显示为文本 `[引用]`，不登记成当前会话的可操作消息。

## 运行行为

服务默认关闭，打开在线账号后按设置启动；关闭、切换账号或退出 WeQ 会断开连接并卸载监听。
备份账号不启动服务。监听复用 WeQ 的数据库增量检测，但独立于界面的「实时消息」开关。
如果切换到另一个 QQ 账号，请重启或重载 cc-connect 的 QQ 通道并选择相应 Agent 会话；当前 cc-connect 的自动重连不会重新读取登录账号。
首次监听只建立基线，不重放历史；断线期间不保证补投，重新连接后的新消息继续上报。原生 QQ 登录及 WeQ 在线收发能力仍需保持可用。

QQ 原始 `msgId` 为 64 位，接口分配有符号 32 位 ID，兼容 cc-connect 的引用上下文。定位索引按账号和数据源保存，最多 8192 条，登记后 30 天过期；正文不复制进索引，热缓存最多 4096 条。正常关闭会刷盘；意外退出可能丢失最后 250ms 内尚未保存的定位，但旧 ID 不会重用给新消息。
索引使用增量日志与定期快照，不逐条重写整份索引；写盘故障会使 `get_status.good=false`，新发送在派发前返回错误。
私聊分页 `msgSeq` 与引用 `clientSeq` 分开登记，发送回执、引用和 QQ 同步消息可关联到同一 ID。索引已淘汰、原文不可回查、跨会话或缺少必要序号时返回错误，不退化成无引用发送。QQ 拒绝发送时返回失败，不自动重发。

OneBot 配置跟随全局配置保存；配置备份时与 MCP 一样进入 API 配置分区。

开发实现与复验命令见 [实施记录](../develop/onebot-practical-service-20261029.md)。
