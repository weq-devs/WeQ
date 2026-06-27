# MCP 服务器

WeQ 内置一个本地 **MCP（Model Context Protocol）服务器**，开启后可以让支持 MCP 的
AI 客户端（Claude Desktop、Cherry Studio 等）直接读取**当前登录账号**的 QQ 聊天数据，
比如「帮我搜一下和老王聊『报销』的记录」「总结一下某个群最近的消息」。

## 特点

- **与账号绑定**：服务只在你已进入某个账号时监听；切换账号或退出账号会自动停止，
  并且自动跟随当前账号的数据，不会串台。
- **只读**：首版只提供读取类工具，不会修改你的任何数据。
- **仅本机**：只监听 `127.0.0.1`（本地回环），并用访问令牌（Bearer Token）鉴权。

## 如何开启

1. 进入任意账号后，打开 **设置 → MCP 服务器**。
2. 打开「启用 MCP 服务器」开关。首次开启会自动生成一个访问令牌。
3. 记下地址（默认 `http://127.0.0.1:8765`）和令牌（可点眼睛图标显示、点复制按钮复制）。
4. 如需更换端口或令牌，可在同一页面修改 / 重新生成（运行中会自动重启服务）。

## 如何连接 AI 客户端

点设置页里的「复制客户端配置」，会得到一段可直接粘贴的 JSON，形如：

```jsonc
{
  "mcpServers": {
    "weq": {
      "url": "http://127.0.0.1:8765",
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
          "http://127.0.0.1:8765",
          "--header",
          "Authorization: Bearer <你的令牌>"
        ]
      }
    }
  }
  ```

配置好后，客户端连上即可调用下列工具。

## 可用工具

| 工具 | 说明 |
| --- | --- |
| `search_messages` | 在本地聊天记录里全文搜索关键词（私聊 / 群聊 / 全部）。 |
| `list_conversations` | 列出最近会话，供挑选目标。 |
| `get_messages` | 读取某个会话最新的若干条消息。 |
| `list_groups` | 列出已加入的群聊。 |
| `list_buddies` | 列出 QQ 好友。 |
| `get_self_profile` | 获取当前账号自己的资料。 |

> 消息里的 `seq`、`uin`、`sendTime` 等数值字段为避免精度问题，均以字符串形式返回。

## 安全提示

- 服务只监听本机，**请不要把地址和令牌暴露到公网或转发端口**。
- 令牌等同于读取你聊天记录的钥匙，怀疑泄露时到设置页「重新生成」即可。
- 关闭开关、退出账号或退出 WeQ，服务都会停止监听。

## 实现说明（给开发者）

- 工具定义集中在 `apps/desktop/src/main/mcp/tools.ts`，是**与传输无关**的注册表
  （`{ name, description, input(zod), run }`）。每个 `run` 调用当前账号的
  `getAppContext().services`，并复用 `ipc/serde.ts` 的 wire 转换。
- HTTP 服务在 `apps/desktop/src/main/mcp/server.ts`，用
  `@modelcontextprotocol/sdk` 的 `McpServer` + `StreamableHTTPServerTransport`。
- 生命周期接在 `context/app_context.ts`（`setAccount` 启动、`clearAccount` 停止、
  `applyMcp` 即时生效），配置存于 `config.json` 的 `settings.mcp`。
- 这层注册表也是将来「应用内置 AI 助手」复用的工具层——助手只需把 `AI_TOOLS`
  转成 Anthropic SDK 的 tool runner 工具即可，业务逻辑零重复。
