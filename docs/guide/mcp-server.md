# 内置 MCP 服务器

WeQ 内置一个本地 **MCP（Model Context Protocol）服务器**，开启后可以让支持 MCP 的 AI 客户端（Claude Desktop、Cherry Studio 等）直接读取**当前登录账号**的 QQ 聊天数据——比如「帮我搜一下和老王聊『报销』的记录」「总结一下某个群最近的消息」「我最近和谁聊得最多」。

## 特点

- **与账号绑定**：服务只在你已进入某个账号时监听；切换账号或退出账号会自动停止，并自动跟随当前账号的数据，不会串台。
- **默认只读**：绝大多数工具只读；例外是明确标注的高级工具 `execute_sql`（可写库）和 `decrypt_database`（写明文副本），使用前请确认其风险。
- **仅本机**：只监听 `127.0.0.1`（本地回环），并用访问令牌（Bearer Token）鉴权。

## 如何开启

1. 进入任意账号后，打开 **设置 → MCP 服务器**。
2. 打开「启用 MCP 服务器」开关。首次开启会自动生成一个访问令牌。
3. 记下地址（默认 `http://127.0.0.1:48765`）和令牌（可点眼睛图标显示、点复制按钮复制）。
4. 如需更换端口或令牌，可在同一页面修改 / 重新生成（运行中会自动重启服务）。

> 若默认端口被占用，服务会自动向后探测（48765 起最多 20 个端口）并绑定第一个可用端口。

## 如何连接 AI 客户端

设置页里还有「安装到本机 AI 客户端」：WeQ 会先扫描本机已安装的
Claude Code / Codex / Cursor / VS Code 等 MCP 客户端，勾选后即可一键把
当前地址与令牌写入对应配置（同一客户端只保留一个 `weq` 条目，不会重复
安装；若服务尚未启用会自动开启）。也可以手动粘贴下面的配置片段。

点设置页里的「复制客户端配置」，会得到一段可直接粘贴的 JSON，形如：

```jsonc
{
  "mcpServers": {
    "weq": {
      "url": "http://127.0.0.1:48765",
      "headers": { "Authorization": "Bearer <你的令牌>" }
    }
  }
}
```

- **原生支持 Streamable HTTP 的客户端**：直接用上面的 `url` + `headers`。
- **只支持 stdio 的旧客户端**（如部分旧版 Claude Desktop）：改用官方桥接命令——

  ```jsonc
  {
    "mcpServers": {
      "weq": {
        "command": "npx",
        "args": [
          "mcp-remote",
          "http://127.0.0.1:48765",
          "--header",
          "Authorization: Bearer <你的令牌>"
        ]
      }
    }
  }
  ```

配置好后，客户端连上即可调用下列工具。

## 可用工具

绝大多数工具为**只读**且**只走本地数据、不发网络请求**（收藏固定读本机 `collection.db`、合并转发只在本地 40900 缓存里找、频道私聊/数据线都读本地表）。返回精简后的 JSON（`msgId` / `uin` / `sendTime` 等数值字段为避免精度问题以字符串返回）。工具的会话标识约定：私聊传对方 `uid`，群聊传群号 `groupCode`；遇到人名/群名先用 `find_contact` 解析成会话标识，再去读/搜。

「凭据」「协议能力」「Web CGI 查询」三节的工具属于例外：它们**需要本机有在线且已登录的 QQ 客户端**（部分还需要「自动注入 QQ」开启），会实时向运行中的 QQ 进程取票据或发包。离线 / 完全离线模式下调用会得到明确报错。

> `execute_sql`（可写库）与 `decrypt_database`（写明文副本到本地目录）是例外的高级工具，不属于只读；它们只在你自己本机、持有令牌的前提下可用。

### 搜索与查找

| 工具 | 说明 |
| --- | --- |
| `search_messages` | 全局全文搜索聊天记录（私聊 / 群聊 / 全部）。 |
| `search_in_conversation` | 在**指定会话内**全文搜索，比全局更精准。 |
| `find_people_who_mentioned` | 搜某关键词并**按发言人聚合**——「还有谁说过 X」。 |
| `find_contact` | 按名字 / 备注 / 群名模糊查找联系人与群，返回会话标识。 |
| `search_buddies` | 按昵称 / 备注模糊搜索好友。 |
| `search_groups` | 按群名模糊搜索群聊。 |

### 会话与消息

| 工具 | 说明 |
| --- | --- |
| `list_conversations` | 列出最近会话（私聊 + 群聊），最新在前。 |
| `get_messages` | 读取某会话消息（时间正序，支持翻页游标 `before` / `nextBefore`）。 |
| `get_messages_by_date` | 读取某会话**某一天**的消息。 |
| `get_forward_messages` | 展开一条**合并转发 / 聊天记录**的内容（只读本地 40900 缓存，不联网补拉）。 |
| `get_message_details` | 取回某条消息的结构化详情：逐条 element 文案、markdown/灰条/卡片 payload、语音转写与本地媒体路径。 |
| `transcribe_voice_message` | 用本机已下载的转写模型把某条消息里的本地语音即时转成文字（只读、不写回数据库）。 |

### 防撤回

| 工具 | 说明 |
| --- | --- |
| `get_anti_recall_status` | 防撤回状态：开关 / 保护范围 / 已装触发器 / QQ 是否在运行。 |
| `list_recalled_messages` | 某会话被撤回过的消息（原内容 + 撤回者 / 时间）。 |
| `list_deleted_messages` | 某会话被删除的消息，标注 WeQ 删（可恢复）还是 QQ 原生删。 |

### 数据线 / 频道私聊

| 工具 | 说明 |
| --- | --- |
| `list_dataline_conversations` | 数据线会话（我的手机 / 电脑 / 平板）。 |
| `get_dataline_messages` | 读取数据线会话消息（按设备判定“我”，PC=本机）。 |
| `list_guild_direct_sessions` | QQ 频道私聊会话列表。 |
| `get_guild_direct_messages` | 读取某频道私聊会话消息。 |

### 收藏

| 工具 | 说明 |
| --- | --- |
| `list_collections` | QQ 收藏列表（固定读本地 `collection.db`，不联网同步微云），支持按类型过滤。 |

### 数据库（高级）

| 工具 | 说明 |
| --- | --- |
| `list_databases` | 列出当前账号目录下的 QQ 数据库文件（`execute_sql` / `decrypt_database` 的选库入口）。 |
| `execute_sql` | 在本地数据库执行 SQL，可读可写（⚠️ 写操作会真的改动 QQ 数据库）。 |
| `decrypt_database` | 把加密库解密成明文 SQLite 副本写到本地目录（默认 fast 快路径）。 |
| `list_db_tables` | 列出某库的表 / 视图 / 索引（无需手写 `sqlite_master`）。 |
| `get_db_columns` | 列出某表的列信息（无需手写 `PRAGMA table_info`）。 |
| `query_sqlite_file` | 对**已解密明文 SQLite** 文件执行只读 SQL（`decrypt_database` 的副本可直接查）。 |
| `decode_blob` | 把 hex / base64 按 protobuf / JCE / schema-free 猜测树解码成可读 JSON，尽量标注字段名。 |
| `decode_db_blob` | 直接取某库中一行的一列 BLOB/TEXT 并解码（`execute_sql` 查 hex 后自动接 `decode_blob`）。 |

### 资料与联系人

| 工具 | 说明 |
| --- | --- |
| `get_self_profile` | 当前登录账号自己的资料。 |
| `get_user_profile` | 某用户详细资料卡（昵称/备注/性别/年龄/生日/签名/亲密度/是否好友）。 |
| `list_buddies` | 列出全部 QQ 好友。 |
| `list_friends_by_intimacy` | 按**亲密度**从高到低列出好友排行。 |

### 群

| 工具 | 说明 |
| --- | --- |
| `list_groups` | 列出加入的群聊。 |
| `list_group_members` | 列出某群成员（支持按群等级排序）。 |
| `get_group_info` | 某群资料详情（群名/群主/人数/建群时间/介绍/置顶/标签）。 |
| `get_group_essence` | 某群精华消息。 |
| `get_group_bulletins` | 某群群公告。 |
| `list_user_groups` | 某用户与我的**共同群**。 |

### 统计与排行

| 工具 | 说明 |
| --- | --- |
| `rank_friends_by_activity` | 好友私聊活跃排行（最近 N 天 / 全部）。 |
| `rank_my_groups_by_activity` | 我加入的群活跃排行（按我的发言量 / 群总量）。 |
| `get_buddy_analytics` | 与某好友的私聊统计分析（活跃度/时段/回复延迟/火花/词云等）。 |
| `get_group_activity` | 某群综合统计（活跃成员/时段/趋势/词云）。 |
| `inspect_timeline` | 单个好友的**关系时间线**（首次/最近/沉默期/逐月/建议阅读窗口）。 |

### 周期概览

| 工具 | 说明 |
| --- | --- |
| `get_daily_digest` | 某一天的活跃摘要。 |
| `get_period_overview` | 账号级周报 / 月报，含与上一周期对比。 |
| `compare_periods` | 对比任意两个日期区间的消息量与收发占比（可限定单会话）。 |

### 凭据（需要在线 QQ）

| 工具 | 说明 |
| --- | --- |
| `get_web_tokens` | 取指定域的 skey / p_skey + bkn（hook 实时取，未注入时 ptlogin2 兜底）。⚠️ 登录凭据，勿泄露。 |
| `get_client_key` | 当前账号的 clientKey 票据。⚠️ 敏感凭据。 |
| `get_download_rkeys` | 媒体下载 rkey（图片 CDN 签名片段，10=私聊 20=群聊）+ 有效期。 |
| `get_ptlogin_jump_url` | 生成 QQ空间 / QQ频道 的免登录跳转 URL（一次性 clientKey 跳转链）。 |

### 协议能力（OIDB，需要在线 QQ）

| 工具 | 说明 |
| --- | --- |
| `get_peer_stats` | 某用户的 QQ 等级（按 uin）+ 资料卡累计获赞（按 uid），两个包并行。 |
| `get_qq_show_url` | 某个 QQ 号的 QQ 秀形象 URL（0xFE1_3）。 |
| `get_flash_share_link` | 把闪传卡片的 fileSetId 换成分享下载链接（0x93d3_1）。 |
| `fetch_history_window` | 从服务端按 seq 窗口拉取缺失/更早的历史消息（单次 ≤ 30 条，结果写入漫游缓存）。 |
| `send_tuwen_ark` | 发送自定义图文 Ark 卡片到群聊（0xdc2_34）。⚠️ 真实发送行为。 |

### Web CGI 查询（需要在线 QQ）

| 工具 | 说明 |
| --- | --- |
| `get_group_honor` | 群荣誉榜单：龙王 / 群聊炽焰 / 群聊传说 / 快乐源泉。 |
| `get_group_albums` | 某群的相册列表（qzone cgi）。 |
| `get_qzone_profile` | 某个 QQ 号的空间说说列表（可深翻）或相册列表。 |
| `get_friend_dress` | 某用户正在使用的个性装扮（挂件/名片/浮屏等；气泡字体查他人拿不到）。 |
| `get_self_dress` | 本账号正在使用的全部装扮（含气泡/字体/头像）。 |
| `get_friend_mutual_mark` | 我与某好友的互动标识（小船/火花/幸运字符，含等级与进度）。 |
| `get_dress_mall` | 装扮商城：排行榜（离线可用，静态榜单兜底）/ 关键词搜索（需在线）。 |

### 字体与装扮资源

| 工具 | 说明 |
| --- | --- |
| `get_dress_resource_url` | 从本地离线 bundle（`resources/dress/*.dat`）查装扮某部件的 CDN URL——纯本地、不需在线 QQ。 |
| `convert_font` | QQ 私有字体 FTF → 标准 TTF 转换（识别 FTFH/FTFG 私有表、坐标解码、重组 glyf）。⚠️ 写本地文件。 |

### 商城表情

| 工具 | 说明 |
| --- | --- |
| `search_market_emoji` | 搜索商城表情包目录（本地离线索引 25000+ 套，可按免费/付费/VIP 过滤）。 |
| `get_market_pack_detail` | 一套表情包的在线详情（CDN android.json：名称/来源/每张表情 hash）。 |
| `get_market_pack_key` | 恢复一套表情包的图片解密密钥（免费包读种子，付费包按 updateTime 爆破 TEA；也可手动传种子时间戳）。 |
| `get_market_pack_image` | 下载并解密一张表情图为明文 GIF（CDN 加密流 → QQTEA → 本地缓存），返回文件路径。 |

> 标记为 **assistant-only** 的工具不通过对外 MCP 暴露，仅供 WeQ 内置 AI 助手调用：`export_conversation`（写导出文件）、`set_anti_recall`（写触发器与配置，含开/关防撤回）、`run_js`（跑一段脚本调用其他工具）。除了副作用，助手还多一块 `run_js` JS 沙箱：模型可以自己写代码批量取数、筛选聚合，沙箱里唯一的对外通道就是 `callTool`（能碰到的能力与助手本身完全一致），没有 `require`/`fetch`/`fs`，超时会被硬中止。对外 MCP 只保留只读查询与上面几个明确标注的高级数据库工具。凭据类工具（`get_web_tokens` / `get_client_key` 等）返回的是你自己的登录票据，请勿把结果转发给不可信的外部服务。

## 安全提示

- 服务只监听本机，**请不要把地址和令牌暴露到公网或转发端口**。
- 令牌等同于读取你聊天记录的钥匙，怀疑泄露时到设置页「重新生成」即可。
- 关闭开关、退出账号或退出 WeQ，服务都会停止监听。

---

## 实现说明（给开发者）

- **工具注册表**：所有工具定义集中在 `apps/desktop/src/main/mcp/tools.ts` 的 `AI_TOOLS`，是**与传输无关**的注册表（`{ name, description, input(zod), run, assistantOnly? }`）。每个 `run` 通过 `getAppContext().services` 解析**当前账号**的服务并复用 `ipc/serde.ts` 的 wire 转换，因此工具自动跟随账号切换、无账号时干净报错。
- **对外 MCP 服务**：`apps/desktop/src/main/mcp/server.ts`，基于 `@modelcontextprotocol/sdk` 的 `McpServer` + `StreamableHTTPServerTransport`，监听 `127.0.0.1`，请求头校验 `Authorization: Bearer <token>`。注册时会**过滤掉 `assistantOnly` 工具**；其余工具默认只读，只有 `execute_sql` / `decrypt_database` 明确允许副作用，需客户端在使用时留意。
- **配置与生命周期**：配置存于全局 `config.json` 的 `mcp`（`{ enabled, port, token }`，默认端口 48765）。生命周期接在 `context/app_context.ts`：进入账号时 `startMcpServer`，切换/退出账号或退出应用时 `stopMcpServer`，改端口时自动重启。
- **设置 UI 与 tRPC**：`components/settings/McpServerSection.tsx` 提供开关 / 端口 / 令牌显示与复制 / 客户端配置复制，对应 `getMcpStatus`、`setMcpEnabled`、`setMcpPort`、`regenerateMcpToken`、`getMcpClientConfig` 等接口。
- **复用**：同一份 `AI_TOOLS` 也被 `apps/desktop/src/main/mcp/openai_tools.ts` 转成函数调用 spec，供 WeQ 内置 AI 助手复用——业务逻辑只写一遍。助手侧的工具执行入口是 `runAssistantTool`（内置工具走注册表、`mcp__*` 走外部 MCP Hub），助手的工具循环与 `run_js` 沙箱里的 `callTool` 都走它，所以沙箱能力不会多于助手本身。
- **代码沙箱**：`apps/desktop/src/main/mcp/js_sandbox.ts`，`node:worker_threads`（字符串 worker，与 `db_decrypt.ts` 同款）+ `node:vm`（`codeGeneration.strings = false`）。放 worker 是为了超时能 `terminate()` 硬杀——`vm` 的 timeout 只管得住同步段，模型写个死循环在 `await` 后面就冻住主进程了。`vm` 在这里是**护栏而非安全边界**（防手滑、防死循环、防污染宿主全局），真正的边界是「宿主机能只能经 `callTool` 出去」。

---

[← 返回使用手册](./index.md)
