# WeQ Web

浏览器版 WeQ —— 同一套后端与界面，跑在 HTTP 上而不是 Electron 窗口里。

适合：想在无桌面环境的机器上跑（NAS / 服务器 / WSL），或者想从另一台设备访问。

> [!Warning]
>
> **这个服务能读取所在机器上 QQ 的全部本地聊天记录。**
> 默认只监听 `127.0.0.1`。要对外暴露，请先读完[远程访问](#远程访问)一节。

---

## 快速开始

需要 **Node.js ≥ 22**（不内置）。

从 [Releases](../../releases) 下载 `weq-web-<版本>.tar.gz`，解压后：

```bash
npm install --omit=dev    # 装 3 个依赖，约 10 秒
node server.mjs
```

终端会打印地址和访问令牌：

```
  WeQ Web  →  http://127.0.0.1:7690
  访问令牌  →  3f9a2b...            (设置 WEQ_TOKEN 可固定)
  导出目录  →  ./weq-exports
```

浏览器打开该地址，粘贴令牌即可进入。之后的流程和桌面版一致：取密钥 → 打开账号 → 看消息。

一个压缩包同时支持 **Windows x64 / Linux x64 / Linux arm64**，启动时按当前平台
自动选择 `native/` 下对应的原生模块。

---

## 配置

全部通过环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEQ_TOKEN` | 随机生成并打印 | 访问令牌。对外暴露时**必须**显式设置 |
| `WEQ_HOST` | `127.0.0.1` | 监听地址。设为 `0.0.0.0` 才对外可见 |
| `WEQ_PORT` | `7690` | 端口。被占用时自动向后探测 10 个 |
| `WEQ_EXPORT_DIR` | `./weq-exports` | 导出文件落盘目录 |
| `WEQ_DATA_DIR` | `./weq-data` | 日志目录 |
| `WEQ_NATIVE_DIR` | 随包的 `native/` | 原生模块目录（一般不用管） |

固定令牌的例子：

```bash
WEQ_TOKEN=$(openssl rand -hex 24) node server.mjs
```

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
| 语音转文字 | 未随包提供 |
| 选择文件 / 文件夹的系统对话框 | 无。导出统一落到 `WEQ_EXPORT_DIR` |
| QQ 空间 / QQ 频道 | 不内嵌，改为在浏览器新标签页打开（见下） |

**QQ 空间 / QQ 频道。** 桌面版把这两个站点嵌在 `<webview>` 里并手工种登录 cookie；
浏览器里两条路都走不通——`user.qzone.qq.com` 与 `pd.qq.com` 都发 `X-Frame-Options`，
iframe 会被拒，跨站 cookie 也不是网页能替浏览器写的。所以网页版改成：点击时向后端现取
一条 ptlogin2 跳转 URL（带一次性 clientKey），交给浏览器开新标签。302 链在浏览器里跑完，
登录 cookie 落进浏览器自己的 jar，之后再访问都是登录态。QQ 未在线时退回裸地址，
在新标签里自己登录一次即可。

其余功能——聊天记录浏览、媒体、导出、分析、克隆、收藏——与桌面版共用同一套后端代码，
行为一致。

---

## 从源码构建

```bash
pnpm i
pnpm --filter @weq/web build     # 产物在 apps/web/dist/
```

开发模式（前端热更新 + 单独跑服务端）：

```bash
pnpm --filter @weq/web dev       # 前端 dev server
pnpm --filter @weq/web start     # 需先 build 过一次
```

### 验证

```bash
pnpm --filter @weq/web test        # 鉴权 + 端到端闸测试
pnpm --filter @weq/web check       # 确认没有 Electron 代码泄漏进 web 构建
pnpm --filter @weq/web test:dist   # 启动打包产物跑一遍完整流程
```

`check` 有两个守卫，都是为了防同一类回归 —— Electron-only 的代码悄悄混进 web 构建后，
不会报错，只会在运行时炸成一句看不懂的 `does not provide an export named 'app'`：

- `check-electron-free`：走真实 import 图，确认 web 复用的桌面模块没有一条链指向 `electron`
- `check-bundle`：扫前端产物，确认 `weq-media://` 之类的自定义协议 URL 全部换成了 HTTP 路由

### 架构

网页版**不复制**桌面版的代码，而是复用：

- `packages/*`（8 个包）—— 零改动，本来就不依赖 Electron
- `apps/desktop/src/main` 的服务装配、tRPC router（259 个 procedure）、三个协议 handler
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

详细的实施记录见 [docs/web-app-plan.md](../../docs/web-app-plan.md)。
