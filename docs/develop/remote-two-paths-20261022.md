# 手机连接模式与会话恢复

用户流程见[Web 与手机连接](../guide/remote-web.md)。手机仍然只承载扫码、凭据和 WebView，业务不另写原生页面。

## 连接与授权

- LAN：桌面辅助程序提供 HTTPS；v3 二维码带端点、一次性邀请和证书 SHA-256 指纹。手机按精确指纹信任电脑，不安装系统证书、不接受任意自签名证书。只允许私有 IPv4 / CGNAT 数字地址。
- 已有 Tailscale：单独的 `existing` 模式只显示 CGNAT HTTPS 地址，复用手机系统路由，仍使用 v3；不要求 Key，不启动手机内嵌节点。LAN 与已有网络的地址分类由同一个共享函数完成，后端也拒绝跨模式选址。
- 内嵌 TS：保留 v2 带 Auth Key 的邀请，通过用户态网络访问电脑；电脑可生成新身份更换网络，保留原节点文件。手机不再弹入网确认或提供手动网络开关。
- 顶层只有 LAN / Tailscale。Tailscale 下的手机已有/没有分别映射为 `existing` / `tailscale`，电脑验证链接共用；更换电脑网络保留手机选择。
- `both` 模式同时提供 LAN HTTPS、TS 内的 HTTP 7691 和 HTTPS 7692。手机已有时选择 TS HTTPS 地址，使用已有系统路由；切换配对页面不停止已配置的 TS 节点。
- 配对初次需要电脑确认，窗口不依赖设置面板处于打开状态。邀请和未批准请求不会持久化；批准后的令牌哈希在桌面私有目录原子保存。手机分别使用 ThisDeviceOnly Keychain / Android Keystore AES-GCM 存储令牌。
- 停服务只断开连接、不删授权；撤销设备先持久化，再断开订阅。写入失败不假报授权或撤销成功。Tailscale 节点权限和过期策略仍独立生效。

## iOS 二次打开修复

`UIViewRepresentable.updateUIView` 不会自动将旧 `WKWebView` 换成新会话中的实例。后台期间 `nil → 新会话` 的中间状态可能被 SwiftUI 合并，旧视图因而继续显示，而新视图没有挂到窗口。

`RemoteView` 以 `ObjectIdentifier(session)` 设置容器身份，强制新会话对应新视图。关闭旧会话时先停止加载、撤下导航代理，再清空 HTML；否则同源限制会拒绝 `about:blank`，使旧页面残留。此修复不修改、删除或轮换设备凭据。

## 连接后加载优化（2026-10-23）

- 内置 Web 服务按 `Accept-Encoding` 协商 gzip，流式压缩大于等于 1 KiB 的 JS/CSS 等静态文本资源；添加 `Vary`，不改变登录鉴权、首页 `no-store`、媒体 Range 或下载行为。
- Web 启动先读取 `bootstrap.currentAccount` 的账号标识；已有会话直接进入主视图，不重复验密钥、重开数据库或等待全量预热。没有账号时保留原启动流程，查询失败不擅自重开。
- iOS 在同一电脑、授权令牌和证书指纹下复用同一个非持久 Web 数据存储；更换身份或删除授权后丢弃，仍不将网页数据持久化到磁盘。存储及缓存行为依据 [Apple WKWebsiteDataStore 文档](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)。
- Android 保留随机回环端口和每次独立的本机 Cookie；代理仅缓存带哈希文件名且明确 `public, immutable` 的 JS/CSS，按电脑与授权隔离，内存预算 12 MiB、单文件上限 8 MiB，不缓存 HTML、业务接口、媒体、失败回应或携带 `Set-Cookie` 的回应。删除电脑或授权失效时丢弃缓存。
- 缓存不绕过本机代理鉴权；新建连接仍须验证电脑在线和设备授权。进程退出后内存缓存不保留，首次访问仍需下载静态资源。

本轮验证：桌面 10 个文件共 39 项针对性测试、桌面 Node/Web 类型检查、指定文件 Biome、隔离 Web 构建、Android Go 竞态测试与 vet、新 Java 绑定生成及 Java 编译、iOS 宿主机 9 项单测和全部 App 源码的 iOS 类型检查通过。现有构建的首屏 JS/CSS 经实际静态服务 gzip 后由 8,462,880 字节降至 1,697,443 字节（约减少 80%）。没有重启或替换正在运行的桌面服务，没有安装新手机包，未运行全仓 CI 或模拟器／真机端到端性能验收；压缩比不代表实机加载耗时已验收。

## 针对性验证

- 桌面配对、落盘、故障关闭、切换模式保留授权、全局请求窗、Web 鉴权与撤销测试。
- 协议测试覆盖 v1/v2/v3、重复字段和非法地址、保存后 URL 还原；Go TLS 测试覆盖指纹不匹配时拒绝连接。
- iOS 原生容器验证同进程替换 WebView、终止并重启 App 后从 Keychain 恢复、设备数仍为一、HTTP/WS 和撤销；LAN 与隔离 TS 均执行。
- Android 原生容器验证 Keystore 保存后重新启动、HTTP/WS、撤销并清除无效凭据，检查浅色/深色与实际前台窗口。
- 隔离 TS 测试额外通过另一用户态节点访问 TS HTTPS 7692 并校验证书，确认未携带设备凭据时仍返回 401。

测试辅助程序使用随机 LAN 端口，不停止或占用用户的 7691 服务；测试控制面、节点和页面均为本机合成数据，不读取真实 QQ。模拟器必须走外盘 guard，结束后关闭本次设备。模拟器 Keychain 需要包含 entitlement 的 ad-hoc 签名构建。
