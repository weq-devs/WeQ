# WeQ Web

浏览器版 WeQ —— 同一套后端与界面，跑在 HTTP 上而不是 Electron 窗口里。

适合：想在无桌面环境的机器上跑（NAS / 服务器 / WSL），或者想从另一台设备访问。

本文介绍独立 Node 部署。已有桌面版时，可从「设置 → WeQ 服务 → Web 与 Remote」
开启内置 Web，直接复用当前账号，无需再启动一份服务。手机配对、HTTPS 入口及内置 Web
能力见[Web 服务与手机连接](../../docs/guide/remote-web.md)。文档对应当前分支源码，不代表已经发布。

> [!Warning]
>
> **这个服务能读取所在机器上 QQ 的全部本地聊天记录。**
> 默认只监听 `127.0.0.1`。要对外暴露，请先读完[远程访问](#远程访问)一节。

---

## 快速开始

需要 **Node.js ≥ 22**（不内置）。

从 [Releases](https://github.com/weq-devs/WeQ/releases) 下载与运行机器匹配的压缩包，解压后：

> 每个平台一个包，请按运行机器选择：
> - Windows x64 → `weq-web-<版本>-win32-x64.tar.gz`
> - Linux x64 → `weq-web-<版本>-linux-x64.tar.gz`
> - Linux arm64 → `weq-web-<版本>-linux-arm64.tar.gz`
> - macOS Intel (x64) → `weq-web-<版本>-darwin-x64.tar.gz`
> - macOS Apple Silicon (arm64) → `weq-web-<版本>-darwin-arm64.tar.gz`

```bash
# Linux / macOS
./start.sh

# Windows：双击 start.bat 即可
```

依赖已随包预装，无需联网 `npm install`。启动脚本会先检查 Node 是否存在、
版本是否 ≥ 22，缺失时给出安装指引。想手动启动就 `node server.mjs`。

请保留 `package.json`、`pnpm-lock.yaml` 和 `runtime-deps.json`。若自行删除了 `node_modules`，
启动脚本会通过 npm 自带的 npx 调用清单锁定版本的 pnpm，按冻结锁文件修复；这一步需要网络或已有工具缓存。
正常解压启动不需要安装 pnpm，也不需要联网。不要改成无锁 `npm install`，否则不再是已验证的依赖树。

终端会打印地址和访问令牌：

```
  WeQ Web  →  http://127.0.0.1:7690
  访问令牌  →  3f9a2b...            (设置 WEQ_TOKEN 可固定)
  导出目录  →  ./weq-exports
```

浏览器打开该地址，粘贴令牌即可进入。之后的流程和桌面版一致：取密钥 → 打开账号 → 看消息。

每个压缩包只包含自己平台的原生模块（`native/`），因此不要跨平台解压使用。

### 助手资源服务

启用 WeQ 助手时，在当前 Web 进程内启动回环静态文件服务；停用助手或结束 Web
进程时关闭，不启动独立 daemon，不注册系统自启。多宿主同时运行时各自拥有服务，
端口占用会向后回落。Web 的登录／开机启动仍由部署方的进程管理器控制。

### Linux 权限

读取本地数据库、使用缓存凭据快速登录或扫码登录取密钥，不需要向 QQ 注入 hook。
需要读取运行中 QQ 的会话物料时，才涉及 `ptrace` 权限；当前实现先尝试普通用户读取，
权限不足时尝试已有权限助手或临时 `sudo`，不再使用旧的 `pkexec` 注入链。

独立 Web 不能安装、修复或撤销长期授权助手。若服务器需要在线内存读取，又没有可用的
现有授权或密码提示环境，应先由部署方配置所需权限；确需 `sudo ./start.sh` 时，该进程
将以 root 权限运行，应同时限制监听范围和访问来源。桌面 Electron 不以 root 运行。

---

## 配置

全部通过环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEQ_TOKEN` | 随机生成并打印 | 访问令牌。对外暴露时**必须**显式设置 |
| `WEQ_HOST` | `127.0.0.1` | 监听地址。设为 `0.0.0.0` 才对外可见 |
| `WEQ_PORT` | `7690` | 端口。被占用时自动向后探测 10 个 |
| `WEQ_EXPORT_DIR` | `./weq-exports` | 导出文件落盘目录 |
| `WEQ_DATA_DIR` | `./weq-data` | 日志写入其 `logs/` 子目录；不是 QQ 数据或全部应用配置的迁移开关 |
| `WEQ_NATIVE_DIR` | 随包的 `native/` | 原生模块目录（一般不用管） |
| `WEQ_QQ_EXE` | 自动探测 | Linux 的 QQ 可执行文件路径。装在非常规位置时手动指定 |

Linux 会依次探测 `/opt/QQ/qq`、`/usr/share/QQ/qq`、`/usr/lib/QQ/qq`、
`~/NapCat/opt/QQ/qq`；都不匹配时用 `WEQ_QQ_EXE` 指过去。

固定令牌的例子：

```bash
WEQ_TOKEN='<已保存的高强度随机令牌>' node server.mjs
```

可先用 `openssl rand -hex 24` 生成并妥善保存令牌；不要把令牌写进仓库。
每次启动都执行随机生成命令会得到新令牌，不是固定令牌。显式设置 `WEQ_TOKEN` 后，
服务不会再把令牌值打印到终端。

---

## 远程访问

绑定到非本机地址时，**必须显式设置 `WEQ_TOKEN`**，否则服务拒绝启动 ——
自动生成的令牌只出现在一行没人会看的日志里，那等于没有门。

```bash
WEQ_TOKEN=$(openssl rand -hex 24) WEQ_HOST=0.0.0.0 node server.mjs
```

暴露前请确认：

- **放在 HTTPS 反向代理之后。** 明文 HTTP 下令牌和聊天记录全程裸奔。
- **令牌要足够长。** 服务端做了每 IP 指数退避，但短令牌仍然扛不住。
- **考虑限制来源 IP。** 这个服务没有多用户概念 —— 拿到令牌就等于拿到全部数据。

已经做了的防护：除登录页和登录接口外一律拒绝；令牌比对用常量时间算法（防时序侧信道）；
会话 cookie 为 `HttpOnly` + `SameSite=Strict`，非本机时加 `Secure`；WebSocket 握手同样校验。

---

## 与桌面版的差异

需要原生外壳的功能在网页版不提供，对应入口已隐藏：

| 功能 | 网页版 |
| --- | --- |
| 窗口最小化 / 最大化 / 关闭、托盘 | 无（浏览器自己管窗口） |
| 在文件管理器中定位 / 打开文件 | 无 |
| 应用锁（Windows Hello 等系统认证） | 无（改由访问令牌把关） |
| 应用内自动更新 | 无（重新下载压缩包即可） |
| 截图当前窗口 | 无 |
| 本地语音转文字等模型推理 | 独立发布包未提供完整推理依赖；有模型文件不等于引擎可用。内置 Web 使用电脑宿主能力 |
| 选择文件 / 文件夹的系统对话框 | 不弹电脑原生文件框；独立部署的导出默认落到 `WEQ_EXPORT_DIR` |
| 从浏览器设备发送普通文件 | 已接入浏览器文件选择与分段上传；非空且 ≤100 MB，不支持群临时会话 |
| 年度报告 PDF / 长图、空间分享图 | 内置 Web / Remote 可复用电脑离屏渲染；独立 Node 部署不支持，可改用 HTML 导出 |
| QQ 空间 / QQ 频道 | 空间使用共享原生业务页；频道网站及显式外部网页入口在新标签页打开 |

**QQ 空间与外部站点。** 主导航的空间已是共享业务页，支持动态、说说、评论与相册，
不是内嵌腾讯网站，详见[空间、相册与频道](../../docs/guide/album-qzone.md)。频道网站或
显式打开腾讯站点时，Web 不嵌入 `<webview>`，也不替浏览器写跨站 Cookie；已有外部跳转
接口可获取一次性 ptlogin2 地址并在新标签页打开。没有可用登录态时，仍需在目标网站登录。
不要分享包含一次性票据的地址。

聊天记录浏览、媒体、导出、分析、克隆、收藏等复用同一套业务后端，但具体能力仍取决于
宿主、模型依赖、QQ 在线状态和权限。浏览器文件发送不代表所有文件框入口都已迁移，
例如收藏表情 ZIP 导入及部分 QQ 图片操作仍依赖桌面文件选择。服务器保存和浏览器下载
也是两个动作，详见[统一导出](../../docs/guide/export.md)。

---

## 从源码构建

```bash
pnpm install --frozen-lockfile
pnpm native:fetch --no-authorization # 取本机原生模块与配套装扮资源
pnpm --filter @weq/web build     # 产物在 apps/web/dist/
pnpm --filter @weq/web deps      # 从根锁文件离线部署运行依赖
```

完整业务验证使用构建后的服务端：

```bash
pnpm --filter @weq/web start     # 服务端默认 7690，提供 dist/public 中的页面
```

`pnpm --filter @weq/web dev` 仅启动 Vite 前端热更新。当前 `vite.config.ts` 没有配置后端
代理，而 HTTP 与 WebSocket 请求使用页面同源地址；直接同时启动 Vite 和 Node 服务不能
自动完成业务联调。需要自行配置同源代理，或重新构建后从服务端地址验证；修改后端源码后
也需重新构建并重启服务。

### 验证

```bash
pnpm --filter @weq/web test        # 鉴权 + 端到端闸测试
pnpm --filter @weq/web check       # 确认没有 Electron 代码泄漏进 web 构建
pnpm --filter @weq/web test:dist   # 启动打包产物跑一遍完整流程
```

`test:dist` 校验 native 是当前平台产物，且包内不包含独立 daemon：

```bash
pnpm --filter @weq/web build       # 构建 + 两个守卫
pnpm --filter @weq/web deps        # 冻结离线部署并检查本平台原生模块与 WASM
pnpm --filter @weq/web test:dist   # 冒烟
```

外置模块清单在 `packages/web-runtime/package.json`，直接版本与桌面冻结记录一致，传递依赖由根锁文件固定。
`deps` 不重新解析 npm 范围、不执行安装脚本；缓存缺件会明确失败，应先完成正常的冻结 workspace 安装。
发布包包含独立完整锁文件与依赖摘要；`pack:release` 会拒绝旧锁、错平台或错版本的产物。
验收可设置绝对路径 `WEQ_WEB_DIST` 和 `WEQ_WEB_RELEASE_DIR`，将构建、守卫、冒烟及压缩输出放在隔离目录。

`check` 有两个守卫，都是为了防同一类回归 —— Electron-only 的代码悄悄混进 web 构建后，
不会报错，只会在运行时炸成一句看不懂的 `does not provide an export named 'app'`：

- `check-electron-free`：走真实 import 图，确认 web 复用的桌面模块没有一条链指向 `electron`
- `check-bundle`：扫前端产物，确认 `weq-media://` 之类的自定义协议 URL 全部换成了 HTTP 路由

### 架构

网页版**不复制**桌面版的代码，而是复用：

- `packages/*` 的业务库与跨平台适配
- `apps/desktop/src/main` 的服务装配、tRPC router、媒体 / 头像 / 资源 handler 与共享 Web 服务模块
- `apps/desktop/src/renderer` 的全部界面

只有两处按构建目标分流：

- **传输层** —— `@transport` 别名：桌面版走 `ipcLink`（IPC），网页版走 `httpBatchLink` + `wsLink`
- **外壳能力** —— `HostBridge` 接口：桌面版注入原生对话框，网页版注入服务端目录 + HTTP 下载

自定义协议在网页版挂成 HTTP 路由，handler 函数本身两端共用：

| 桌面版 | 网页版 |
| --- | --- |
| `weq-media://pic?t=…` | `GET /_media/pic?t=…` |
| `weq-avatar://fetch?src=…` | `GET /_avatar/fetch?src=…` |
| `weq-asset://brand/logo.png` | `GET /_asset/brand/logo.png` |

当前跨端能力与验证范围见[功能对齐记录](../../docs/develop/web-remote-parity-20261026.md)和
[连接与加载优化记录](../../docs/develop/web-remote-optimization-20261026.md)。
