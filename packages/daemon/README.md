# @weq/daemon — Rust 守护进程

WeQ 伴生守护进程：**开机自启的回环静态 HTTP 服务器**，专职服务 WeQ 助手推文的封面与跳转页。与 WeQ 之间走一条本地控制管道通信，后续扩展功能（例如「监听 GitHub release 更新」）都通过新增管道命令实现，而不是让守护进程变成一个大型静态服务器。

**铁律：守护进程永远不碰 QQ 数据库、不读写 WeQ 配置。** 端口与 docroot 都是 WeQ 运行时通过管道下发的，进程重启后由 WeQ 重新下发。

## 架构定位

```
WeQ Desktop (Electron)                    weq-daemon (本包，原生二进制)
┌──────────────────────────┐   管道命令    ┌────────────────────────────┐
│ 渲染推文 HTML/PNG 落盘     │ ──────────▶ │ 127.0.0.1:<port> 静态文件服务 │
│ syncTweets 等全部 QQ 库逻辑 │  http_start  │ docroot 只读                │
│ （全部留在 GUI 侧）        │ ◀────────── │ 控制管道（named pipe/UDS）    │
└──────────────────────────┘   响应 JSON   └────────────────────────────┘
                                                    ▲ HTTP
                                               QQ 抓卡片渲染
```

## 管道协议

传输层：Windows named pipe / Unix domain socket（`$TMPDIR/<pipe>.sock`），分帧为 `4 字节小端长度 + JSON`，单帧上限 1 MiB。

命令（`cmd` tag，snake_case）：

| 命令 | 参数 | 响应 | 说明 |
| --- | --- | --- | --- |
| `ping` | — | `pong { version, http_running }` | 探活 |
| `http_start` | `port`, `docroot` | `started { port }` | 开启（或按新参数替换）HTTP 服务；同参数幂等；成功后**记忆**到状态文件 |
| `http_stop` | — | `stopped` | 关 HTTP 并**清除记忆**（重启后保持关闭）；守护进程本体存活 |
| `http_status` | — | `http_status { running, port?, docroot? }` | 查询状态 |
| `release_watch_start` | `{ api_base, repo, interval_secs, current_version }` | `release_watch_status { info }` | 开启（或按新参数重启）GitHub release 轮询（Rust 实现，普通轮询） |
| `release_watch_stop` | — | `stopped` | 关闭轮询（latest_seen / pending 保留） |
| `release_watch_status` | — | `release_watch_status { info }` | 查询轮询状态（含未确认的新版本 `pending`） |
| `release_ack` | `version` | `release_watch_status { info }` | GUI 已处理该版本：清 pending、推进 current_version |
| `autostart_set` | `{ enabled, gui_exe }` | `autostart_applied { enabled }` | 注册 / 撤销 **WeQ GUI** 的开机自启（写平台注册 + 落记忆）——Electron 自己不注册任务 |
| `autostart_sync` | — | `autostart_applied { enabled }` | 按记忆对账一次（WeQ 拉起守护进程后调用，修复被手动删除的注册） |
| `autostart_status` | — | `autostart_status { enabled, registered }` | 意图 vs 平台注册实际在位 |
| `stop` | — | （无帧，EOF） | 优雅退出守护进程；**保留记忆**（重启后按记忆恢复） |

`release_watch_status.info = { watching, repo?, interval_secs?, current_version?, latest_seen?, pending?, last_error? }`。发现比 `current_version` 新的 release ⇒ 置 `pending`，GUI 轮询状态读它弹系统通知提醒更新，处理后 `release_ack`。

### 跨重启记忆

守护进程把最近一次成功的 `http_start {port, docroot}` 存进自己的状态文件（按管道名区分，release 监控与 GUI 自启记忆也住同一目录）：

- Windows：`%LOCALAPPDATA%\weq-daemon\<pipe>.json`
- macOS：`~/Library/Application Support/weq-daemon/<pipe>.json`
- Linux：`$XDG_STATE_HOME/weq-daemon/<pipe>.json`（默认 `~/.local/state/`）

`serve` 启动时若记忆存在且 docroot 仍是有效目录，就**自主恢复 HTTP**——电脑重启后 WeQ 不在场，推文卡片的 URL 依然可用。容错：docroot 消失 → 等待 WeQ 重新下发（保留记忆）；端口被占 → 只记日志、保持空闲（管道照常活着）；文件损坏 → 删除视为无记忆。`http_stop` 是唯一的「遗忘」入口，`stop`/进程退出/崩溃都不影响记忆（写盘用临时文件 + rename 原子落盘，崩溃不留坏文件）。

响应同样以 `res` tag 分型：`pong` / `started` / `stopped` / `http_status` / `error { message }`。

示例（Node 侧）：

```ts
import net from 'node:net';

function frame(obj: object): Buffer {
  const json = Buffer.from(JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length);
  return Buffer.concat([head, json]);
}

const sock = net.connect('/tmp/weq-daemon.sock'); // win32: \\.\pipe\weq-daemon
sock.on('connect', () => sock.end(frame({ cmd: 'http_start', port: 17690, docroot: '/path/to/docroot' })));
```

## 单例与版本对齐

**单例。** 同一个管道名只允许一份 `serve`：启动时先探测有没有实例在服务（Unix 先
`connect`、连不上才清残骸 socket 再 bind；Windows 靠 `first_pipe_instance`），已有实例
就直接退出，报 `another weq-daemon is already serving ...`。所以重复启动既不会抢 HTTP
端口，也不会按记忆重复拉起 GUI；Unix 侧更不会误删在跑实例的 socket 文件。

**版本对齐（GUI 侧）。** 桌面版和网页版共用 `ensureDaemonRunning()`：探活 + 读磁盘二进制
的 `--version`，版本一致就什么都不做（不重启、不重复拉起）；不一致（换了安装包 / 重新
`build:daemon`）才向旧实例发 `stop`、等管道消失、再拉起新二进制。新实例 `serve` 启动时
按状态文件自行恢复 HTTP。

注意 `stop` 与 `http_stop` 的区别：`stop` 只关停 HTTP 再退出进程、**状态文件保留**；
`http_stop` 才是「遗忘」入口（清状态文件）。所以版本替换不会丢推送卡片的服务地址。

同一台机器同时跑桌面版、网页版、`pnpm dev` 时，它们连的是同一条默认管道，因此只会
有一份守护进程 —— 代价是它们必须用**同一个版本**，否则会互相 `stop` 换新。开发时想
隔离多套实例就用 `--pipe <name>`（GUI 侧目前固定用默认管道名）。

## CLI

```
weq-daemon serve              # 守护进程模式（自启动注册的命令）
weq-daemon ping|http-status|release-status|autostart-status|stop [--pipe <name>]
weq-daemon install|uninstall|status [--pipe <name>]
```

`--pipe` 覆盖默认管道名（`weq-daemon`），同一台机器可并存多套实例做测试。

自启动注册（`install`/`uninstall`）按平台落位，注册命令行只有 `serve --pipe <name>`，不含端口与路径：

- Windows：`schtasks /SC ONLOGON`
- macOS：`~/Library/LaunchAgents/weq-daemon.plist`（RunAtLoad + KeepAlive）
- Linux：systemd user unit + `loginctl enable-linger`

## 构建 / 打包

```
pnpm run build:daemon            # release 构建 → resources/daemon/<platform>-<arch>/weq-daemon[.exe]
pnpm --filter @weq/daemon build:debug
pnpm --filter @weq/daemon clippy # CI 门禁：-D warnings
pnpm --filter @weq/daemon test
```

产物按 `resources/daemon/<platform>-<arch>/` 落位（`win32-x64` / `linux-x64` / `linux-arm64` / `darwin-x64` / `darwin-arm64`）：

- 桌面版：electron-builder 的 `extraResources` 原样拷贝 `resources/`，二进制随安装包发布（release 环境约 0.7 MB）。
- 浏览器版：每个平台/架构各产一个压缩包（release web 矩阵在各自 runner 上跑
  `build:daemon`），`apps/web/scripts/build-server.mjs` 把当前平台的
  `resources/daemon/<platform>-<arch>/` 拷进 `dist/`，`smoke-dist.ts` 校验本平台二进制齐全。

## 设计边界（刻意的）

- HTTP 只绑 `127.0.0.1`；无扩展名路径自动尝试 `.html` / `index.html`；路径穿越（`..`、反斜杠、编码绕过）一律 404。
- `serve` 启动时不开 HTTP、不监听 TCP 端口 —— 只挂管道等 WeQ 下发命令。WeQ 从未打开过的机器上，它只是一个几乎为零的空闲进程。
- 主题 / 内容刷新全在 WeQ 侧发布成静态文件；守护进程零渲染逻辑，保持「傻」。
