# WeQ Remote 手机壳独立仓库

2026-10-23（北京时间）。只拆分手机连接壳，不拆 Web 业务，也不改变现有设备协议或授权。

本次移除提交只包含原 `apps/ios`、`apps/android` 的删除、维护入口修正和仓库边界检查。新版电脑 Web 接入及跨仓库夹具属于独立的在途改动，不随本次提交合入；下述新版夹具入口已在当前工作区验证，需其对应实现提交后再从干净 checkout 使用。

## 维护入口

- WeQ：`/Users/wata4me/Projects/WeQ-upstream`，维护 Web 页面、业务 API、数据库、电脑配对批准 / 撤销和网络辅助程序。
- WeQ Remote：`/Users/wata4me/Projects/WeQ-Remote`，维护 `apps/ios`、`apps/android`、原生连接 / WebView / 缓存、手机构建与测试。入口为该仓库的 `README.md`、`AGENTS.md` 和 `docs/protocol.md`。
- 当前仅创建本地 Git 仓库，尚无远端链接，不自动公开、推送或发布。

手机目录原地迁移，约 1 GiB 的既有 `.build` 和本机生成工程未复制、未提交。原仓库的其他未提交改动保留。手机路径历史通过限定 `apps/ios`、`apps/android` 的 fast-export / fast-import 导入；新仓库另有拆分前完整快照，提交对照见其 `MIGRATION.md`。原 WeQ 历史不重写。

## 开发与更新

业务页面继续修改本仓库的共享 renderer / Web，构建电脑端后手机刷新即可；后端变更通常需重启电脑端。原生扫码、权限、连接、证书或 WebView 变更在手机仓库构建安装。两边独立版本，不要求 App 版本号等于电脑版本号。

移仓库不改变 Bundle ID、Keychain / Keystore 名称、电脑授权、userData 或外盘模拟器路径；没有卸载手机 App 或清除凭据。生成的 Xcode 工程和构建缓存有旧绝对路径时，正常重新生成 / 重建，不保留旧入口软链接。

## 集成测试边界

真实电脑端协议实现仍在本仓库。增强版跨仓库测试约定以下合成服务入口（目前为工作区实现，不属于本次移除提交）：

```sh
pnpm exec tsx scripts/remote-integration-server.ts
node --test scripts/remote-integration-server.test.mjs
```

可用 `WEQ_REMOTE_CLIENT_REPO=/Users/wata4me/Projects/WeQ-Remote` 运行上述测试，以通过独立手机仓库的 Python 启动入口验证实际跨仓库往返；不设置时电脑仓库可独立运行同一测试。

服务默认仅监听 `127.0.0.1:45198`，`/test/contract` 返回夹具版本 1、状态协议 1、邀请版本 1/2/3。测试网页在 `apps/desktop/test/fixtures/remote-web`；隔离控制面与 DERP 仍由 `tools/remote-network/ios-test-network` 提供。服务使用合成数据、自动批准测试设备，绝不是产品授权入口。

独立手机仓库通过 `WEQ_DESKTOP_REPO` 或 `--desktop-repo` 选择本仓库，调用上述进程 / HTTP 入口；手机源文件不再直接 import 桌面私有模块。手机产品构建不需要本仓库或 Node/pnpm，集成测试才需要。

本机测试只证明对应源码和接口可以工作，不自动等于真机、公共控制面、蜂窝切网或加载性能验收。迁移后的实际验证结果写入手机仓库的 `MIGRATION.md`。
