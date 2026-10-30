# WeQ 替代 NapCat 接入 cc-connect

## 实现

- `apps/desktop/src/main/onebot/server.ts`：回环 OneBot v11 WebSocket、Bearer 升级鉴权、echo 响应、新消息事件、有限消息 ID 映射及短期媒体 URL。
- `apps/desktop/src/main/onebot/runtime.ts`：账号绑定、独立 `createNtMsgDbHook` 监听、WeQ 现有发送与媒体服务适配。配置应用串行化，账号关闭会立即使旧后台失效。
- 设置增加 OneBot 页面，配置默认关闭；不修改 cc-connect 源码或重建 Agent 引擎。
- `get_login_info`、`get_group_info`、`get_msg`、`set_input_status`、`send_private_msg`、`send_group_msg`、`upload_group_file` 等 action 的输入，直接核对本机 cc-connect `platform/qq/qq.go`，不是仅凭 OneBot 名称猜测。

接口支持范围与运行步骤见 [用户指南](../guide/onebot-cc-connect.md)。

## 定向验证

```sh
pnpm --dir apps/desktop exec vitest run test/onebot_server.test.ts test/onebot_runtime.test.ts test/onebot_settings.test.ts
pnpm --dir packages/service exec vitest run test/onebot_config.test.ts
pnpm --filter @weq/desktop typecheck
```

交叉验证可选提供已有 cc-connect 源码目录，不自动克隆或下载依赖：

```sh
WEQ_CC_CONNECT_SOURCE=/absolute/path/to/cc-connect \
  pnpm --dir apps/desktop exec vitest run test/onebot_cc_connect.test.ts
```

该测试在本机启动真实 WeQ OneBot WebSocket 服务，再从指定源码目录执行 Go QQ 适配器探针。
验证实际适配器登录握手、@ 入站解析、32 位引用、图片 MIME/文件下载，以及文本、图片、群文件回发。Go 模块下载禁用。
测试仅使用合成账号、消息与媒体，不连接 QQ 或模型端点；协议测试通过不代表已安装新版 WeQ、已切换运行中的 cc-connect 或完成真实 QQ 验收。

## 本轮结果

2026-10-29（北京时间）：桌面端定向测试 65 项、service 配置与备份定向测试 83 项均通过，包含上面的真实 Go QQ 适配器联测；桌面主进程与渲染进程类型检查通过，改动文件 Biome 检查与 Git 空白检查通过。
未调整产品版本号，未改动 cc-connect 的运行配置、二进制或现有 NapCat 服务，未签名、安装或发布。
