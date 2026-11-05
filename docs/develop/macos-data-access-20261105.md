# macOS QQ 数据访问引导（2026-11-05）

## 已核实的触发原因

本机安装版启动时，系统日志先记录 `app.weq.desktop` 对
`kTCCServiceSystemPolicyAppDataDetailed` 的旧代码要求不匹配，再拒绝读取 QQ
容器中的 `login.db` 和 `nt_msg.db`。WeQ 的 `testDatabaseKey` 随后抛出
`Operation not permitted (os error 1)`，这是文件读取阶段失败，不是密钥校验不通过。

## 实现

- 主进程 `qq_data_access.ts` 在同进程中枚举实际平台候选根目录，只读打开两处
  `login.db` 及各 `nt_qq_*` 账号的 `nt_db/nt_msg.db`，读取一个字节后关闭句柄。
- 仅将文件系统返回的 `EPERM` / `EACCES` 归为读取受限；缺文件与其他 I/O 错误分别处理。
  不拿 native 的任意英文错误推断磁盘授权，不访问 TCC 数据库，不解密或修改 QQ 数据。
- tRPC 入口复用 HostBridge 的当前应用路径和外链能力；Web 宿主与非 macOS 平台不探测，
  Web 不提供操作服务器系统设置的按钮。设置链接为 macOS 深链，跳转失败保留手动导航说明。
- 启动自动进入在本机读取受限时退回账号页；已保存的静态备份不受影响。
  提示提供系统设置入口和显式重试，恢复后刷新账号与安装状态；仍拒绝时提示彻底退出再启动。

## 签名

当前 `scripts/sign-macos.mjs` 已保留配置的真实签名身份，无证书时才使用 ad-hoc。
ad-hoc 的现有授权不能假定跨构建稳定；此次不伪造稳定代码要求、不改签名或系统授权记录。
仍需在具备真实证书时验证跨版本签名身份及授权延续情况，本次不声称已解决该问题。

## 验证入口

```bash
pnpm --filter @weq/desktop exec vitest run test/qq_data_access.test.ts test/qq_data_access_notice.test.ts
node apps/desktop/test/browser/run-qq-data-access.mjs
```

单测使用模拟文件系统与合成错误，浏览器仅渲染合成路径并拦截外网，不操作真实 QQ、
不更改 macOS 授权。浏览器沿用 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE`，
可用 `WEQ_ACCESS_ARTIFACTS` 指定截图目录。

授权操作依据：[Apple 设置说明](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac)；
打开协议链接复用 [Electron shell.openExternal](https://www.electronjs.org/docs/latest/api/shell)。
真实系统设置深链和重新授权后的安装版恢复需另行人工验证。

本轮离线验证：5 份专项及相邻启动测试共 26 项通过；桌面主进程和渲染层类型检查通过。
浏览器验证真实启动账号页的 24 组桌面／窄屏、深浅色／跟随系统、主题色及背景组合，
检查长路径换行、重试反馈及备份入口。没有打包安装或修改运行中的 WeQ。
