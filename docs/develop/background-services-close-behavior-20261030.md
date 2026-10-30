# 后台服务与关闭/退出行为（2026-10-30）

把「关窗口后后台服务还在不在跑」从两套互不知晓的确认框，收敛成一处设置 + 一个统一弹窗。

## 改之前

- 点 ✕ 且 `windowCloseBehavior === 'ask'`（旧默认）→ 渲染层 `CloseConfirmDialog`。
- 真正退出且 `weqAssistant.enabled` → 主进程原生 `dialog.showMessageBox`（取消／只关闭窗口／确认退出），**没有「不再询问」**，每次退出都弹。
- 现实路径因此是「关窗弹一次 → 选退出 → 又弹一次」。若给 MCP / OneBot 也各加确认就是三次。

## 改之后

### 默认最小化到托盘

`DEFAULT_APP_SETTINGS.windowCloseBehavior` 从 `'ask'` 改为 `'tray'`。**不加一次性迁移**：
`getSettings()` 的读归一是 `normalizeWindowCloseBehavior(s?.windowCloseBehavior) ?? 默认值`，
配置文件里写过该字段的用户保持原值，从没写过的直接落到新默认 —— 这正是期望行为。

### 一个统一的服务判据

`apps/desktop/src/main/background_services.ts` 是唯一入口，退出确认和设置页共用：

| 服务 | 判据 |
| --- | --- |
| MCP | `isMcpRunning()` |
| OneBot | `oneBotStatus().running` |
| 公众号推送 | `assistantResourceServer.status().running` |
| Web | `desktopWebRuntime.status().enabled` |
| Remote | `remoteRuntime.status().enabled` |
| SSE | `isSsePushActive()` |

只算**真正在监听/推送**的：「已启用但等待账号」不算 —— 此刻退出不会中断任何连接，
拿它拦退出只会让用户莫名其妙。

SSE 没有监听端口，只能从服务实例判断：`SsePushService.hasTarget`（`target !== null`），
再经 `app_context.isSsePushActive()` 暴露。配置里选了目标但账号没开时不算运行中。

### 退出确认走渲染层

`quit_confirm_ipc.ts` 与 `attach_hint_ipc.ts` 同构（`SharedPrompt` 合并并发 + token 防串 +
sender 校验 + 60s 超时）：

```
主 → 渲染  quit:confirm  { token, services: string[] }
渲染 → 主  quit:respond  { token, choice: 'quit'|'window'|'cancel', remember }
主 → 渲染  quit:cancel-confirm  { token }   // 超时/销毁时收起死框
```

窗口不可用时**直接放行退出**，否则 `before-quit` 会永远等不到回应。窗口在托盘里时先
`show()` + `focus()` 再发。

`app_quit_confirmation.ts` 的 `showDialog` 返回值放宽为 `QuitChoice | QuitAnswer`，
旧形态（直接返回字符串）等价于 `remember: false`，既有调用点与测试无需改动。
新增 `onRemember` 回调只在非 `cancel` 时触发。

### 「不再询问」的语义

新偏好 `quitConfirmSuppressed`（沿用 `suppressAttachHint` / `suppressDbDamageReminder` 的命名）。
**刻意不按服务集合失效**：勾过之后即使又开启新服务也不重新弹。理由是用户表达的是
「我知道退出会停服务，别再问了」；用服务集合哈希判定会让开关一次 MCP 就复活弹窗，
行为不可预测，还要额外存快照。当前运行的服务在「后台服务」页常驻展示，信息不丢失。

它只管 `before-quit`，不改变点 ✕ 的关窗行为 —— 两者正交。

## 设置页

「WeQ 服务 → 后台服务」放在该组第一位（总览在前）。六张卡片只读展示状态与地址，
开关仍留在各自二级页 —— 不重复实现六套 mutation，也不会和那些页已有的联动确认
（Web ↔ Remote、公众号 ↔ 登录自启）打架。

「关闭窗口时」的分段控件在这里和「常规 → 提醒与窗口」各有一份，读写同一个
`windowCloseBehavior`。页面间跳转走 `SettingsNavigateContext`（`controls.tsx` 新增），
由 `SettingsDialog` 提供。

`remote.*` 在 Web 构建下是 FORBIDDEN 的 local procedure，汇总页必须
`enabled: active && !IS_WEB`，否则 Web 设置页会反复弹错。

## 未改动的部分

- `will-quit` 的两轮语义（第一轮被 `registerAppQuitCleanup` 拦下做异步清理）原样保留；
  退出确认发生在 `before-quit`，早于清理。
- `assistantResourceServer.shutdown()` 的 `quitting = true` 不可逆标记未动，只在真正退出时触发。
- `skipNextQuitConfirmation()` 的三个调用点（`storage_cleanup.ts`、`host.ts`、测试）未动。

## 复验

```sh
pnpm --dir apps/desktop exec vitest run test/app_quit_confirmation.test.ts test/quit_confirm_ipc.test.ts test/background_services.test.ts test/background_services_section.test.ts test/settings_target_resolution.test.ts test/settings_retention.test.ts test/settings_alias_manifest.test.ts test/icon_consistency.test.ts test/settings_reorganization.test.ts
pnpm --filter @weq/service exec vitest run test/user_config_preferences.test.ts
pnpm typecheck && pnpm lint
```

本轮未发送真实 QQ 消息、未连接模型端点；UI 改动未在真机上逐个切换主题验证。
