# 内置 MCP 服务器

WeQ 内置一个本地 **MCP（Model Context Protocol）服务器**，开启后可以让支持 MCP 的 AI 客户端（Claude Desktop、Cherry Studio 等）直接读取**当前登录账号**的 QQ 聊天数据——比如「帮我搜一下和老王聊『报销』的记录」「总结一下某个群最近的消息」「我最近和谁聊得最多」。

## 特点

- **与账号绑定**：服务只在你已进入某个账号时监听；切换账号或退出账号会自动停止，并自动跟随当前账号的数据，不会串台。
- **只读**：对外只暴露读取类工具，不会修改你的任何数据。
- **仅本机**：只监听 `127.0.0.1`（本地回环），并用访问令牌（Bearer Token）鉴权。

## 如何开启

1. 进入任意账号后，打开 **设置 → MCP 服务器**。
2. 打开「启用 MCP 服务器」开关。首次开启会自动生成一个访问令牌。
3. 记下地址（默认 `http://127.0.0.1:48765`）和令牌（可点眼睛图标显示、点复制按钮复制）。
4. 如需更换端口或令牌，可在同一页面修改 / 重新生成（运行中会自动重启服务）。

> 若默认端口被占用，服务会自动向后探测（48765 起最多 20 个端口）并绑定第一个可用端口。

## 如何连接 AI 客户端

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

所有工具均为**只读**，返回精简后的 JSON（`msgId` / `uin` / `sendTime` 等数值字段为避免精度问题以字符串返回）。工具的会话标识约定：私聊传对方 `uid`，群聊传群号 `groupCode`；遇到人名/群名先用 `find_contact` 解析成会话标识，再去读/搜。

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

> 另有一个导出工具 `export_conversation`（把会话导出为本地文件）标记为 **assistant-only**，因涉及写文件，**不通过对外 MCP 暴露**，仅供 WeQ 内置 AI 助手调用。

## 安全提示

- 服务只监听本机，**请不要把地址和令牌暴露到公网或转发端口**。
- 令牌等同于读取你聊天记录的钥匙，怀疑泄露时到设置页「重新生成」即可。
- 关闭开关、退出账号或退出 WeQ，服务都会停止监听。

---

## 实现说明（给开发者）

- **工具注册表**：所有工具定义集中在 `apps/desktop/src/main/mcp/tools.ts` 的 `AI_TOOLS`，是**与传输无关**的注册表（`{ name, description, input(zod), run, assistantOnly? }`）。每个 `run` 通过 `getAppContext().services` 解析**当前账号**的服务并复用 `ipc/serde.ts` 的 wire 转换，因此工具自动跟随账号切换、无账号时干净报错。
- **对外 MCP 服务**：`apps/desktop/src/main/mcp/server.ts`，基于 `@modelcontextprotocol/sdk` 的 `McpServer` + `StreamableHTTPServerTransport`，监听 `127.0.0.1`，请求头校验 `Authorization: Bearer <token>`。注册时会**过滤掉 `assistantOnly` 工具**，保证对外只读、无副作用。
- **配置与生命周期**：配置存于全局 `config.json` 的 `mcp`（`{ enabled, port, token }`，默认端口 48765）。生命周期接在 `context/app_context.ts`：进入账号时 `startMcpServer`，切换/退出账号或退出应用时 `stopMcpServer`，改端口时自动重启。
- **设置 UI 与 tRPC**：`components/settings/McpServerSection.tsx` 提供开关 / 端口 / 令牌显示与复制 / 客户端配置复制，对应 `getMcpStatus`、`setMcpEnabled`、`setMcpPort`、`regenerateMcpToken`、`getMcpClientConfig` 等接口。
- **复用**：同一份 `AI_TOOLS` 也被 `apps/desktop/src/main/mcp/openai_tools.ts` 转成函数调用 spec，供 WeQ 内置 AI 助手复用——业务逻辑只写一遍。

---

[← 返回使用手册](./index.md)
