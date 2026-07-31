# WeQ Web App（apps/web）实施计划

浏览器打开的前后端形态，与 `apps/desktop` 并存、共享 `packages/*` 与 tRPC router。

> **状态：M0–M5 全部完成。** 实施结果与偏差见文末「实施记录」。

---

## 0. 调查结论（改动量基线）

| 层 | electron 耦合 | 处置 |
|---|---|---|
| `packages/*`（8 个包） | **0 处** | 原样复用，一行不动 |
| `main/context/app_context.ts`（~800 行服务装配） | **0 处** | 原样复用 |
| `main/ipc/trpc.ts`（16 行）、`ipc/router.ts` | **0 处** | 原样复用 |
| 14 个 router / **259 procedure** / 14 subscription | **2 文件 ~19 处** | 抽 `HostBridge` 注入 |
| 3 个协议 handler（media 447 / avatar 67 / resource 83 行） | `protocol.handle` + `net.fetch` | 抽适配器，双端共用 |
| `renderer/`（51k 行） | **13 处** `window.electron` | 删 / 换 |
| 协议 URL 拼接 | `lib/resourceUrl.ts` 15 个函数已集中 + 13 处散点 | 加前缀变量 |

关键前提（已验证）：
- `nt_helper.node` / `NineBird.node` 均为 **N-API** → 纯 Node 可直接加载，无需 rebuild。
- `packages/db` **不依赖 better-sqlite3**，全部走 `nt_helper.executeSqlWithKey()`；`better-sqlite3` 仅存在于 `packages/codec` 的 tools/tests 语境，`src/` 零引用 → **运行时零 sqlite 原生模块**。
- `packages/native/src/loader.ts:149` 支持 `WEQ_NATIVE_DIR` 环境变量覆盖 → 打包路径可控。
- `main/mcp/server.ts`、`main/weq_assistant/server.ts` 已有 `node:http` + Token + `tryListen` 端口 fallback 的成熟模板。

---

## 1. 目标形态

```
apps/web/
  package.json
  src/
    server/
      index.ts              # 入口：装配 + 启动
      http.ts               # node:http server + 路由分发（抄 mcp/server.ts 骨架）
      auth.ts               # ★ 鉴权闸（本方案安全核心）
      trpc_adapter.ts       # tRPC standalone/fetch adapter 挂载
      protocol_adapter.ts   # IncomingMessage→Request / Response→res 适配
      host_bridge.ts        # HostBridge 的 web 实现
      static.ts             # 前端静态产物托管
    client/
      main.tsx              # 复用 desktop renderer
      index.html
  vite.config.ts
```

产物：`dist/server.mjs`（esbuild 单文件） + `dist/public/`（前端） + `native/`。

---

## 2. 分步骤

### M0 — 骨架 + 鉴权（先把门守住）

**新建** `apps/web/package.json`，`pnpm-workspace.yaml` 的 `apps/*` 已覆盖，无需改。

**新建** `src/server/auth.ts` — 这是远程场景唯一的安全边界，必须先做：

- 启动时读 `WEQ_TOKEN` 环境变量；未设置则生成随机 token 并打印到控制台（同时写入 `~/.weq/web-token`）。
- 登录端点 `POST /_auth/login`，body `{token}`，比对用 **`crypto.timingSafeEqual`**（防时序侧信道），成功则下发 `HttpOnly; SameSite=Strict; Secure(非 loopback 时)` 的会话 cookie。
- 中间件 `requireAuth(req)`：**默认拒绝**。白名单仅 `/_auth/login`、登录页 HTML、登录页所需的静态资源。**其余全部（含 `/trpc/*`、`/_media/*`、`/_avatar/*`、`/_asset/*`）一律校验。**
- 登录失败计数 + 指数退避（同 IP 连续失败则延迟响应），防暴力枚举。
- 会话存内存 Map（重启失效，可接受），带 TTL。
- `BIND_HOST` 默认 `127.0.0.1`；要远程必须显式设 `0.0.0.0`，且此时**强制要求 `WEQ_TOKEN` 已显式设置**（不接受自动生成），否则拒绝启动 —— 避免"随手开了远程但 token 只打印在没人看的日志里"。

**新建** `src/server/http.ts` — 抄 `main/mcp/server.ts:148-200` 的 `tryListen` + `startServer` 骨架，路由分发：

```
/_auth/*   → auth.ts
/trpc/*    → trpc_adapter.ts   (requireAuth)
/_media/*  → protocol_adapter  (requireAuth)
/_avatar/* → protocol_adapter  (requireAuth)
/_asset/*  → protocol_adapter  (requireAuth)
其余       → static.ts (SPA fallback → index.html)
```

**验收**：起服务，未带 cookie 访问 `/trpc/bootstrap.xxx` 返回 401；带正确 token 登录后返回 200。

---

### M1 — HostBridge 抽象（解耦 19 处 electron）

**新建** `packages/service/src/host/bridge.ts`（或放 `apps/desktop/src/main/host.ts` + web 各一份实现，接口放共享处）：

```ts
export interface HostBridge {
  pickDirectory(opts?: { title?: string }): Promise<string | null>;
  pickSaveTarget(defaultName: string): Promise<string | null>;
  revealPath(p: string): Promise<void>;      // web: no-op
  appVersion(): string;
  isPackaged(): boolean;
}
```

**改** `main/context/app_context.ts` — `AppContext` 增加 `host: HostBridge` 字段，`initAppContext()` 接受注入。

**改** `main/ipc/routers/account.ts:22` — 删 `import { dialog } from 'electron'`，11 处（`showOpenDialog`×5 / `showSaveDialog`×3 / `shell.openPath`×2 / `dialog.error`×1）改走 `ctx.host.*`。

**改** `main/ipc/routers/bootstrap.ts:17` — 删 `import { app, dialog } from 'electron'`，~8 处同上。

**新建** desktop 侧实现（`dialog`/`shell`/`app` 原样）与 web 侧实现：
- `pickDirectory` → 返回服务端预设导出根目录（配置项 `WEQ_EXPORT_DIR`，默认 `~/.weq/exports`），前端不弹系统对话框
- `pickSaveTarget` → 同上，落盘后前端走 `GET /_download?id=` 取文件
- `revealPath` → no-op（前端按钮已删）

**验收**：`pnpm -r typecheck` 通过；desktop 行为无变化；`grep "from 'electron'" ipc/routers/` 零命中。

---

### M2 — 协议 handler 双端共用

`protocol.handle(scheme, req => Response)` 用的是 Web 标准 `Request`/`Response`，与 `node:http` 同构。

**改** `media_protocol.ts` / `avatar_protocol.ts` / `resource_protocol.ts`：把 handler 主体抽成纯函数 `handleMediaRequest(req: Request): Promise<Response>`，只留 `protocol.handle(SCHEME, handleMediaRequest)` 这一行 electron 代码在 desktop 侧。

`net.fetch`（media 2 处、resource 1 处）替换为全局 `fetch`（Node 22 原生有；desktop 侧行为等价，electron 的 `net.fetch` 优势主要是走系统代理 —— 若依赖代理则保留注入式：`deps.fetch`）。

**新建** `src/server/protocol_adapter.ts`（~80 行）：
- `IncomingMessage` → `Request`：把 `/_media/pic?t=&name=` 重写为 `weq-media://pic?t=&name=`，headers 透传（`Range` 必须透传，视频/音频要 seek）
- `Response` → `res`：`writeHead(status, headers)` + `Readable.fromWeb(body).pipe(res)`

**验收**：desktop 图片/视频/语音/表情/装扮全部正常；web 端同一张图两边字节一致。

---

### M3 — tRPC over HTTP

**新建** `src/server/trpc_adapter.ts` — `@trpc/server/adapters/standalone` 的 `createHTTPHandler`（或 fetch adapter），挂 `appRouter`，`createContext` 从 cookie 取会话。**router 与 259 个 procedure 一行不动。**

14 个 subscription 全部是 `observable` + EventEmitter（零 electron），需要传输层支持：
- tRPC v10 的 HTTP subscription 走 **SSE**（`httpSubscriptionLink`），或
- 更省事：`wsLink` + `applyWSSHandler`（`ws` 已是 workspace 现成依赖）

选 **WS**：一个连接覆盖全部 14 路，且与现有 `observable` 写法完全兼容。WS 握手时同样校验 cookie。

**改** `renderer/src/trpc/client.ts:41`：
```diff
- links: [ipcLink() as unknown as TRPCLink<AppRouter>]
+ links: [splitLink({ condition: op => op.type === 'subscription',
+   true: wsLink({client: wsClient}), false: httpBatchLink({url:'/trpc'}) })]
```
用条件编译/环境变量区分两个 app 的 link（`import.meta.env.VITE_TARGET`）。

**验收**：web 端进账号、查消息、导出进度条（subscription）实时更新。

---

### M4 — 前端适配（含按钮删除）

**改** `lib/resourceUrl.ts` — 15 个函数内部的 `weq-media://` 前缀提取为常量：
```ts
const MEDIA = import.meta.env.VITE_TARGET === 'web' ? '/_media/' : 'weq-media://';
```
另 13 处散点（`QqMedia.tsx` / `avatarCache.ts` / `dressSkin.ts` / `graphModel.ts` / `views/cache/*` 等）收敛到 helper。

**删除功能 + 对应 UI 按钮**（按你的要求，前端按钮一并删）：

| 功能 | 位置 | 处置 |
|---|---|---|
| 窗口最小化/最大化/关闭 | `im-template/template/TitleBar.tsx:18,22,26` | web 构建下整个 TitleBar 不渲染 |
| 关窗确认 | `components/CloseConfirmDialog.tsx:21` | 不挂载 |
| 窗口布局 | `lib/windowLayout.ts:17` | no-op |
| 资源管理器定位 | `components/QqMedia.tsx:65,72` (`media:reveal`/`file:reveal`) | **删按钮**，保留"复制路径" |
| 文件下载 | `QqMedia.tsx:87` (`file:download`) | 改走 `GET /_download` |
| 窗口截图 | `capture:window` | **删按钮** |
| 系统认证（Windows Hello） | `system_auth.ts` | **删入口**，鉴权已由 token 承担 |
| 应用内更新 | `update/updater.ts` + 设置页更新区块 | **删区块**，`update` router 在 web 下不挂载 |
| 打开日志目录 | `logs:open-dir` | **删按钮** |
| 托盘 | `index.ts:102 buildTray` | 不存在 |

做法：`components/host/` 下加 `<DesktopOnly>` 包装组件（web 构建返回 `null`），配合 vite `define` 让 rollup tree-shake 掉。

**验收**：web 端无任何点了没反应的按钮；`grep "window.electron" ` 在 web 构建产物中零命中。

---

### M5 — 构建与打包

**新建** `apps/web/vite.config.ts` — 复用 desktop renderer 的 alias（`@renderer` 指向 `../desktop/src/renderer/src`）、react、tailwind 插件；`define: {'import.meta.env.VITE_TARGET': '"web"'}`。

**构建脚本**（根 `package.json`）：
```json
"build:web": "vite build --config apps/web/vite.config.ts && esbuild apps/web/src/server/index.ts --bundle --platform=node --format=esm --external:ws --external:*.node --outfile=dist/web/server.mjs"
```
（`build:bot` 那条已验证过这套 esbuild 打包路径可行）

**三种交付**：

| 形态 | 内容 | 体积 | 说明 |
|---|---|---|---|
| **A. 不带 node** | `server.mjs` + `public/` + `native/` | **~15 MB**（10 MB 是 `nt_helper.node`） | 要求 Node ≥22。默认形态 |
| **B. 自带 node（推荐）** | A + 同目录 `node.exe` + `start.bat` | ~60 MB | 解压即用，零打包器坑，`.node` 加载正常 |
| **C. SEA / `@yao-pkg/pkg`** | 单 exe | ~110 MB | 对 `.node` 加载支持别扭，**不推荐** |

A 与 B 共享同一产物，B 只多两个文件 —— 构建差异 < 10 行。

`native/` 通过 `WEQ_NATIVE_DIR` 指向随包目录，`loader.ts` 无需改。

`sherpa-onnx-node`（语音转录）是另一个原生模块：web 版**默认不带**，`transcribe` 相关 procedure 在 web 下不挂载；需要时按 desktop 的 `extraResources` 方式补。

**验收**：干净机器解压运行，浏览器打开 → 登录 → 进账号 → 看消息 → 导出。

---

## 3. 安全（远程场景）

按你的定位，**重点在最外层鉴权闸**：

1. **默认拒绝** — `requireAuth` 覆盖 `/trpc`、`/_media`、`/_avatar`、`/_asset`、`/_download`，白名单只有登录页与登录端点。
2. **`timingSafeEqual`** 比对 token，失败退避。
3. **绑 `0.0.0.0` 时强制显式 `WEQ_TOKEN`**，否则拒启动。
4. HttpOnly + SameSite=Strict cookie；非 loopback 时置 Secure（提示用户上 HTTPS/反代）。
5. WS 握手同样校验。

次要（记录但不阻塞）：`localfile?path=<绝对路径>` 在远程下是任意文件读取，闸后仍建议加个前缀白名单 —— 放 M2 收尾时顺手做。

---

## 4. 顺序与依赖

```
M0 骨架+鉴权 ──┐
M1 HostBridge ─┼─→ M3 tRPC ──→ M4 前端 ──→ M5 打包
M2 协议适配器 ─┘
```

M1 / M2 可与 M0 并行，且**两者都对 desktop 是净收益**（解耦 + 无行为变化），可以先单独合入。

## 5. 工作量估计

- 新写：~1200–1800 行（server 外壳 + 适配器 + 鉴权 + 两份 HostBridge 实现）
- 改动：现有 ~40 处（19 router + 13 前端 electron + 协议 handler 签名 + URL 前缀收敛）
- `packages/*`：**0 行**

---

## 6. 实施记录

### 与计划的偏差

**electron 耦合点比静态 grep 多。** 计划里数出 19 处，实际 22 处：`dressup.ts` 和
`file_resource.ts` 用的是**动态** `await import('electron')`，静态 grep 抓不到。
另外发现 `shell.showItemInFolder`（定位并高亮）与 `shell.openPath`（打开）语义不同，
`HostBridge` 拆成了 `revealInFolder` / `revealPath` 两个方法。

**传递依赖是主要障碍，且只在运行时暴露。** router 本身干净了，但仍有三条链把
electron 拖进来，每次都表现为难懂的 `does not provide an export named 'app'`：

| 污染链 | 处置 |
|---|---|
| `app_context` → `qq_protocol`（`app.getApplicationInfoForProtocol`） | 缓存拆到 `qq_protocol_cache.ts` |
| 三个协议 handler 与 `protocol.handle` 同文件 | 注册集中到 `protocol_register.ts` |
| `ipc/router` → `routers/update` → `updater`（`electron-updater`） | 类型/事件总线拆到 `update/state.ts`，动作经 `UpdateActions` 由外壳注入 |

这促成了 `scripts/check-electron-free.ts`：走真实 import 图，把运行时崩溃前移成构建期失败。
它当场就抓出了第三条链。

**`net.fetch` 需要自己实现替代。** Node 的全局 `fetch` 不支持 `file://`，所以新写了
`file_response.ts`（`createReadStream` 流式 + 完整 Range 支持）。media 里 `fileResponse`
有 24 个调用点，为免改 24 处签名，用 `AsyncLocalStorage` 传递当前 request。

**esbuild 打包踩了三个 CJS 互操作坑**（均由 `smoke-dist.ts` 暴露）：
`silk-wasm` 要 `__filename`；`__dirname` 直接声明会与 bundle 内既有声明冲突（改用
`define`）；`exceljs` 动态 `require('crypto')` —— esbuild 的桩会先看 `typeof require`，
所以 banner 里定义 `require` 即可放行。

**前端散点比预期少。** `lib/resourceUrl.ts` 已是集中 helper（15 个函数），42 处引用里
只有 7 处真正散落。但手工 grep 漏了 `avatarCache.ts` 与 `resourceUrl.ts` 各有一份
`weq-avatar://` 构造器 —— 因此加了 `scripts/check-bundle.ts` 扫产物。

### 最终结构

```
apps/web/
  src/server/{index,http,auth,trpc_adapter,protocol_adapter,host,static,login_page}.ts
  src/server/{auth,http}.test.ts
  scripts/{build-server.mjs,check-electron-free.ts,check-bundle.ts,smoke-dist.ts}
  vite.config.ts
```

传输层用 `@transport` 别名分流：desktop → `transport.electron.ts`（`ipcLink`），
web → `transport.web.ts`（`httpBatchLink` + `wsLink`）。`AppRouter` 与 259 个
procedure 两端完全共用。

### 验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck`（13 个 workspace） | 全绿 |
| `biome lint`（295 文件） | 0 |
| desktop `electron-vite build` | 0 error |
| `auth.test.ts` | 23/23 |
| `http.test.ts`（端到端闸） | 24/24 |
| `file_response` Range 语义 | 21/21 |
| `check-electron-free` | 44 模块纯净 |
| `check-bundle` | 304 产物纯净 |
| `smoke-dist`（真实打包产物启动） | 12/12 |

### 交付物

`dist/` 65 MB：`server.mjs` 5.7 MB + `public/` 13 MB + `native/` 38 MB + `resources/` 9.2 MB。
`native/` 同时含 win32-x64 / linux-x64 / linux-arm64，由 `@weq/native` 的 loader 按
`process.platform`/`arch` 自动选 —— **一个包三平台通用**。不内置 Node（需 ≥22），
运行前 `npm install --omit=dev` 装 3 个 external 包（`ws` + `@resvg/resvg-js`）。

前端 bundle 2.09 MB（desktop 是 4.33 MB），`electron-trpc` 已完全消失。

### 已知限制

- `DesktopOnly` 是运行时组件，其 children 仍留在 chunk 里（不渲染但没被 tree-shake）。
  要真正剔除需改成构建期条件编译。
- `smoke-dist.ts` 只验到 HTTP 层；`DesktopOnly` 的 DOM 行为未做无头浏览器断言。
- WS subscription 未在真实浏览器里跑通（服务端已挂载，14 个 subscription 待实测）。
- 语音转录（`sherpa-onnx-node`）未纳入 web 包。
- 远程部署时 `localfile?path=` 仍是任意文件读取面 —— 闸后风险，但建议补前缀白名单。
