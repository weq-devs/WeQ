# 本机浏览器与 Remote 入口解耦

2026-11-09（北京时间）。两个入口独立启停，共享业务与页面，不新增业务进程或手机协议版本。

## 结构

- `main/web/application.ts` 的 `WebCore` 持有共享 Web 宿主、页面配置和业务路由；每个入口创建独立的 `WebApplication`，管理该入口的认证、在途响应及 WebSocket。
- `DesktopWebRuntime.start()` 只启动本机浏览器监听与浏览器登录，`stop()` 只清理该入口。`webServiceAutoStart` 继续保存原来的本机入口偏好，不做自动迁移或改写。
- `RemoteRuntime` 在启动时通过注入工厂获得 Remote Web 入口，直接挂载共享请求处理与订阅，不再转发到本机 Web 端口。停止、辅助程序故障及启动失败均释放该入口，不停止本机浏览器入口。
- `RemoteWebGateway` 负责设备凭据与来源检查；共享 Web 核心不导入 Remote 配对实现。本机入口不接受 Remote 设备令牌，Remote 不接受本机浏览器登录 Cookie。
- 桌面启动先配置共享核心，再恢复 Remote。两个入口仍复用桌面当前账号，不分别初始化账号或数据库。

| 本机浏览器访问 | Remote | 运行结果 |
| --- | --- | --- |
| 关闭 | 关闭 | 无入口监听或订阅 |
| 开启 | 关闭 | 仅本机浏览器 |
| 关闭 | 开启 | 仅 Remote，未启动本机浏览器端口 |
| 开启 | 开启 | 两个入口共享业务，各自独立清理 |

## 设置与兼容

设置中的 Web 开关改名为「允许本机浏览器访问」，自动启动相应改名；删除开启 Remote、关闭本机入口及取消本机自动启动时的联动确认。原设置键、桌面管理 RPC 和手机配对协议保持不变，既有设备无需重新配对。旧搜索词仍可定位到新控件。

两块设置保留在同一页，但分别持有查询、刷新、操作中状态、复制状态和错误提示。任一入口启动、停止、复制或失败都不禁用另一块；操作只刷新所属入口状态，不清除另一块的错误。

独立 Node Web 部署沿用原有启动流程；手机 App 无需为此次入口调整重新构建。运行中的旧桌面程序不会因源码修改自动更新。

## 验证入口

- `apps/desktop/test/web_runtime.test.ts`：合成页面、业务 API、压缩资源、HTTP / WebSocket、两种凭据隔离、入口交叉启停及设备撤销。
- `apps/desktop/test/remote_runtime.test.ts`：启动、停止、辅助程序故障与 Remote 资源释放。
- `apps/desktop/test/remote_section.test.ts`：开关不联动、不修改另一入口的自动启动偏好，令牌复制反馈保留。
- `scripts/remote-integration-server.ts`：不启动本机浏览器入口的真实 Remote 协议合成夹具。
- `apps/desktop/test/browser/run-remote-entry.mjs`：真实设置组件的开关独立性、浅深色及 320 / 390 / 1280 像素视口；通过 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 复用已有浏览器依赖。

本轮于 2026-11-10（北京时间）验证：9 个相关测试文件共 140 项通过，桌面主进程与渲染层类型检查、22 个相关文件的 Biome 检查、独立 Node Web 测试、跨仓库协议夹具和 6 组浏览器布局检查均通过。浏览器测试完成后关闭本轮浏览器与测试服务。

自动测试不操作真实 QQ；不将本机 HTTP / WebSocket 通过等同于真实手机、局域网或 Tailscale 验收。
